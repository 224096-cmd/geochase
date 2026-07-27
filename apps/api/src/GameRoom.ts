import { DurableObject } from "cloudflare:workers";
import type { Env, LatLng, RegionKey, GameMode } from "./types";
import { findStreetPoint, moveAI, haversineKm, buildPlaceHints, randomFallbackPoint } from "./mapillary";

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_TIME_LIMIT_SECONDS = 1800; // 30分
const CORRECT_RADIUS_KM = 0.5;
const MAX_ROUNDS = 8;
const VISITED_HISTORY = 6;

interface RoomState {
  mode: GameMode;
  status: "idle" | "running" | "finished";
  round: number;
  aiPosition: LatLng | null;
  visited: LatLng[];
  imageUrl: string;
  imageId: string;
  hint: string;
  revealedHints: string[];
  nextUpdateAt: number;
  intervalMs: number;
  region: RegionKey;
  timeLimitSeconds: number;
  startedAt: number;
}

const DEFAULT_STATE: RoomState = {
  mode: "chase",
  status: "idle",
  round: 0,
  aiPosition: null,
  visited: [],
  imageUrl: "",
  imageId: "",
  hint: "",
  revealedHints: [],
  nextUpdateAt: 0,
  intervalMs: DEFAULT_INTERVAL_MS,
  region: "japan_wide",
  timeLimitSeconds: 0,
  startedAt: 0,
};

export class GameRoom extends DurableObject<Env> {
  sockets: Set<WebSocket> = new Set();
  gameState: RoomState = { ...DEFAULT_STATE };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Durable Objectはアイドル時にメモリが揮発するため、保存された状態があれば復元する
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomState>("gameState");
      if (saved) this.gameState = saved;
    });
  }

  private async persist() {
    await this.ctx.storage.put("gameState", this.gameState);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/start") && req.method === "POST") {
      let mode: GameMode = "chase";
      let region: RegionKey = "japan_wide";
      let intervalMs = DEFAULT_INTERVAL_MS;
      let timeLimitSeconds = 0;
      try {
        const body = (await req.json()) as {
          mode?: GameMode;
          region?: RegionKey;
          intervalSeconds?: number;
          timeLimitSeconds?: number;
        };
        if (body?.mode) mode = body.mode;
        if (body?.region) region = body.region;
        if (body?.intervalSeconds) intervalMs = Math.max(5, body.intervalSeconds) * 1000;
        if (body?.timeLimitSeconds) timeLimitSeconds = Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(30, body.timeLimitSeconds));
      } catch {
        // ボディなし/不正なら既定値
      }

      if (mode === "classic") await this.startClassicMode(region, timeLimitSeconds);
      else await this.startChaseMode(region, intervalMs);

      return Response.json({ ok: true, state: this.publicState() });
    }

    if (url.pathname.endsWith("/stop") && req.method === "POST") {
      await this.stopGame();
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

    if (this.gameState.mode === "classic") {
      const score = Math.max(0, Math.round(5000 - distanceKm * 5));
      const target = this.gameState.aiPosition;
      this.gameState.status = "finished";
      await this.persist();
      this.broadcast({
        type: "result",
        distanceKm: Math.round(distanceKm * 100) / 100,
        correct: distanceKm <= CORRECT_RADIUS_KM,
        score,
        target,
      });
      this.broadcast({ type: "state", ...this.publicState() });
      return;
    }

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
      await this.advanceChaseRound();
    }

    try {
      await this.env.DB.prepare(
        `INSERT INTO guesses (id, round_id, user_id, guess_lat, guess_lng, distance_km, score, guessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), `${this.ctx.id.toString()}-r${this.gameState.round}`, userId, lat, lng, distanceKm, score, Date.now())
        .run();
    } catch (err) {
      console.error("D1 write failed", err);
    }
  }

  async startClassicMode(region: RegionKey, timeLimitSeconds: number) {
    await this.ctx.storage.deleteAlarm();
    const found = await findStreetPoint(this.env.MAPILLARY_TOKEN, region);
    const position = found?.point ?? randomFallbackPoint(region);

    this.gameState = {
      ...DEFAULT_STATE,
      mode: "classic",
      status: "running",
      round: 1,
      aiPosition: position,
      visited: [position],
      imageUrl: found?.imageUrl ?? "",
      imageId: found?.imageId ?? "",
      region,
      timeLimitSeconds,
      startedAt: Date.now(),
    };
    await this.persist();
    this.broadcast({ type: "state", ...this.publicState() });

    if (timeLimitSeconds > 0) {
      await this.ctx.storage.setAlarm(Date.now() + timeLimitSeconds * 1000);
    }
  }

  async startChaseMode(region: RegionKey, intervalMs: number) {
    await this.ctx.storage.deleteAlarm();
    const found = await findStreetPoint(this.env.MAPILLARY_TOKEN, region);
    const position = found?.point ?? randomFallbackPoint(region);
    const hints = await buildPlaceHints(position);

    this.gameState = {
      ...DEFAULT_STATE,
      mode: "chase",
      status: "running",
      round: 1,
      aiPosition: position,
      visited: [position],
      imageUrl: found?.imageUrl ?? "",
      imageId: found?.imageId ?? "",
      hint: hints[0] ?? "",
      revealedHints: hints,
      nextUpdateAt: Date.now() + intervalMs,
      intervalMs,
      region,
      startedAt: Date.now(),
    };
    await this.persist();
    this.broadcast({ type: "state", ...this.publicState() });
    await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }

  async stopGame() {
    await this.ctx.storage.deleteAlarm();
    this.gameState.status = "idle";
    await this.persist();
    this.broadcast({ type: "state", ...this.publicState() });
  }

  async advanceChaseRound() {
    await this.ctx.storage.deleteAlarm();
    await this.moveToNextLocation();
  }

  async alarm() {
    if (this.gameState.status !== "running") return;

    if (this.gameState.mode === "classic") {
      this.gameState.status = "finished";
      await this.persist();
      this.broadcast({ type: "result", distanceKm: null, correct: false, score: 0, target: this.gameState.aiPosition, timeUp: true });
      this.broadcast({ type: "state", ...this.publicState() });
      return;
    }

    await this.moveToNextLocation();
  }

  private async moveToNextLocation() {
    if (!this.gameState.aiPosition) return;

    const found = await moveAI(this.env.MAPILLARY_TOKEN, this.gameState.region, this.gameState.aiPosition, this.gameState.visited);
    const position = found?.point ?? this.gameState.aiPosition;
    const hints = await buildPlaceHints(position);

    this.gameState.round += 1;
    this.gameState.aiPosition = position;
    this.gameState.visited = [...this.gameState.visited, position].slice(-VISITED_HISTORY);
    this.gameState.imageUrl = found?.imageUrl ?? this.gameState.imageUrl;
    this.gameState.imageId = found?.imageId ?? this.gameState.imageId;
    this.gameState.hint = hints[0] ?? "";
    this.gameState.revealedHints = hints;

    if (this.gameState.round > MAX_ROUNDS) {
      this.gameState.status = "finished";
      await this.persist();
      this.broadcast({ type: "state", ...this.publicState() });
      return;
    }

    this.gameState.nextUpdateAt = Date.now() + this.gameState.intervalMs;
    await this.persist();
    this.broadcast({ type: "state", ...this.publicState() });
    await this.ctx.storage.setAlarm(Date.now() + this.gameState.intervalMs);
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
    return {
      mode: this.gameState.mode,
      round: this.gameState.round,
      maxRounds: this.gameState.mode === "classic" ? 1 : MAX_ROUNDS,
      imageUrl: this.gameState.imageUrl,
      imageId: this.gameState.imageId,
      hint: this.gameState.hint,
      revealedHints: this.gameState.revealedHints,
      status: this.gameState.status,
      region: this.gameState.region,
      intervalSeconds: this.gameState.intervalMs / 1000,
      timeLimitSeconds: this.gameState.timeLimitSeconds,
      secondsUntilNext:
        this.gameState.mode === "chase" && this.gameState.status === "running"
          ? Math.max(0, Math.round((this.gameState.nextUpdateAt - Date.now()) / 1000))
          : 0,
      secondsElapsed:
        this.gameState.status === "running" ? Math.round((Date.now() - this.gameState.startedAt) / 1000) : 0,
    };
  }
}