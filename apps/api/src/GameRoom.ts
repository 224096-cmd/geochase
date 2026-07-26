import { DurableObject } from "cloudflare:workers";
import type { Env, LatLng } from "./types";
import { fetchRandomStreetPoint, nextRoadPoint, haversineKm } from "./mapillary";

const UPDATE_INTERVAL_MS = 30_000; // AIが移動する間隔
const CORRECT_RADIUS_KM = 0.5; // この範囲内なら「特定成功」
const MAX_ROUNDS = 8;

interface RoomState {
  status: "idle" | "running" | "finished";
  round: number;
  aiPosition: LatLng | null;
  imageUrl: string;
  hint: string;
  revealedHints: string[];
  nextUpdateAt: number;
}

const HINT_POOL = [
  "近くに川がある",
  "海岸から近い",
  "山間部を走っている",
  "標識の言語がわかる",
  "気温はおおよそ推測できる",
  "道路の中央線の色が特徴的",
  "近くに大きな交差点がある",
  "建物の密度が高いエリア",
];

export class GameRoom extends DurableObject<Env> {
  sockets: Set<WebSocket> = new Set();
  gameState: RoomState = {
    status: "idle",
    round: 0,
    aiPosition: null,
    imageUrl: "",
    hint: "",
    revealedHints: [],
    nextUpdateAt: 0,
  };

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/start") && req.method === "POST") {
      await this.startChaseMode();
      return Response.json({ ok: true, state: this.publicState() });
    }

    if (url.pathname.endsWith("/state") && req.method === "GET") {
      return Response.json(this.publicState());
    }

    return new Response("not found", { status: 404 });
  }

  handleSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);
    ws.send(JSON.stringify({ type: "state", ...this.publicState() }));

    ws.addEventListener("message", (ev) => this.onMessage(ws, ev));
    ws.addEventListener("close", () => this.sockets.delete(ws));
    ws.addEventListener("error", () => this.sockets.delete(ws));
  }

  async onMessage(ws: WebSocket, ev: MessageEvent) {
    let payload: any;
    try {
      payload = JSON.parse(ev.data as string);
    } catch {
      return;
    }

    if (payload.type === "guess") {
      await this.handleGuess(ws, payload.lat, payload.lng, payload.userId ?? "anon");
    }
  }

  async handleGuess(ws: WebSocket, lat: number, lng: number, userId: string) {
    if (this.gameState.status !== "running" || !this.gameState.aiPosition) return;

    const distanceKm = haversineKm({ lat, lng }, this.gameState.aiPosition);
    const correct = distanceKm <= CORRECT_RADIUS_KM;
    const score = correct ? Math.max(100, Math.round(1000 - distanceKm * 20)) : 0;

    ws.send(
      JSON.stringify({
        type: "result",
        distanceKm: Math.round(distanceKm * 100) / 100,
        correct,
        score,
      })
    );

    if (correct) {
      this.broadcast({ type: "caught", userId, round: this.gameState.round });
      await this.advanceRoundOrFinish();
    }

    // D1へ記録（失敗しても致命的ではないのでtry/catchで囲む）
    try {
      await this.env.DB.prepare(
        `INSERT INTO guesses (id, round_id, user_id, guess_lat, guess_lng, distance_km, score, guessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          `${this.ctx.id.toString()}-r${this.gameState.round}`,
          userId,
          lat,
          lng,
          distanceKm,
          score,
          Date.now()
        )
        .run();
    } catch (err) {
      console.error("D1 write failed", err);
    }
  }

  async startChaseMode() {
    // 日本国内のランダムな都市近辺から開始（必要に応じて範囲を変更可能）
    const seedCenters: LatLng[] = [
      { lat: 35.681, lng: 139.767 }, // 東京
      { lat: 34.694, lng: 135.502 }, // 大阪
      { lat: 35.011, lng: 135.768 }, // 京都
      { lat: 43.062, lng: 141.354 }, // 札幌
    ];
    const center = seedCenters[Math.floor(Math.random() * seedCenters.length)];

    const found = await fetchRandomStreetPoint(this.env.MAPILLARY_TOKEN, center);
    if (!found) {
      // Mapillaryにデータが無い場合は中心地点をそのまま使う
      this.gameState = {
        status: "running",
        round: 1,
        aiPosition: center,
        imageUrl: "",
        hint: this.pickHint(),
        revealedHints: [],
        nextUpdateAt: Date.now() + UPDATE_INTERVAL_MS,
      };
    } else {
      this.gameState = {
        status: "running",
        round: 1,
        aiPosition: found.point,
        imageUrl: found.imageUrl,
        hint: this.pickHint(),
        revealedHints: [],
        nextUpdateAt: Date.now() + UPDATE_INTERVAL_MS,
      };
    }

    this.broadcast({ type: "state", ...this.publicState() });
    await this.ctx.storage.setAlarm(Date.now() + UPDATE_INTERVAL_MS);
  }

  async alarm() {
    if (this.gameState.status !== "running" || !this.gameState.aiPosition) return;

    const bearing = Math.random() * 360;
    const nextPoint = await nextRoadPoint(this.gameState.aiPosition, bearing, 0.8);

    // 移動先の近くでMapillary画像を探す。見つからなければ座標だけ更新
    const found = await fetchRandomStreetPoint(this.env.MAPILLARY_TOKEN, nextPoint, 0.01);

    this.gameState.round += 1;
    this.gameState.aiPosition = found ? found.point : nextPoint;
    this.gameState.imageUrl = found ? found.imageUrl : this.gameState.imageUrl;
    this.gameState.hint = this.pickHint();

    if (this.gameState.round > MAX_ROUNDS) {
      this.gameState.status = "finished";
      this.broadcast({ type: "state", ...this.publicState() });
      return;
    }

    this.gameState.nextUpdateAt = Date.now() + UPDATE_INTERVAL_MS;
    this.broadcast({ type: "state", ...this.publicState() });
    await this.ctx.storage.setAlarm(Date.now() + UPDATE_INTERVAL_MS);
  }

  async advanceRoundOrFinish() {
    // 誰かが正解したら即座に次のラウンドへ（アラームを待たない）
    await this.alarm();
  }

  pickHint(): string {
    const remaining = HINT_POOL.filter((h) => !this.gameState.revealedHints?.includes(h));
    const hint = remaining[Math.floor(Math.random() * remaining.length)] ?? HINT_POOL[0];
    this.gameState.revealedHints = [...(this.gameState.revealedHints ?? []), hint];
    return hint;
  }

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(data);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  publicState() {
    // aiPositionそのものはクライアントへ送らない(答えを漏らさないため)
    return {
      round: this.gameState.round,
      maxRounds: MAX_ROUNDS,
      imageUrl: this.gameState.imageUrl,
      hint: this.gameState.hint,
      revealedHints: this.gameState.revealedHints,
      status: this.gameState.status,
      secondsUntilNext: Math.max(0, Math.round((this.gameState.nextUpdateAt - Date.now()) / 1000)),
    };
  }
}
