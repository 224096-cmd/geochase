import { DurableObject } from "cloudflare:workers";
import type { Env, LatLng, RegionKey, GameMode, GameStatus, PublicState, RoundRecord, ClientMessage } from "./types";
import {
  findStreetPoint,
  moveAI,
  haversineKm,
  bearingDeg,
  buildPlaceHints,
  randomFallbackPoint,
  regionScaleKm,
} from "./mapillary";

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_SECONDS = 10;
const MAX_TIME_LIMIT_SECONDS = 1800; // 30分
const CORRECT_RADIUS_KM = 0.5;
const CHASE_ROUNDS = 8;
const DEFAULT_CLASSIC_ROUNDS = 5;
const MAX_CLASSIC_ROUNDS = 10;
const TRAIL_LENGTH = 12;
const HINT_PENALTY = 250; // ヒント1つあたりの減点
const RETRY_PENALTY = 60; // 逃走モードで外すたびの減点
const GUESS_COOLDOWN_MS = 1500;

interface RoomState {
  mode: GameMode;
  status: GameStatus;
  round: number;
  maxRounds: number;
  aiPosition: LatLng | null;
  trail: LatLng[];
  revealedTrail: LatLng[];
  imageUrl: string;
  imageId: string;
  isPano: boolean;
  allHints: string[];
  revealedHintCount: number;
  hintPenalty: number;
  attempts: number;
  totalScore: number;
  history: RoundRecord[];
  nextUpdateAt: number;
  roundEndsAt: number;
  intervalMs: number;
  region: RegionKey;
  timeLimitSeconds: number;
  startedAt: number;
  lastBearing: number | null;
}

const DEFAULT_STATE: RoomState = {
  mode: "chase",
  status: "idle",
  round: 0,
  maxRounds: CHASE_ROUNDS,
  aiPosition: null,
  trail: [],
  revealedTrail: [],
  imageUrl: "",
  imageId: "",
  isPano: false,
  allHints: [],
  revealedHintCount: 0,
  hintPenalty: 0,
  attempts: 0,
  totalScore: 0,
  history: [],
  nextUpdateAt: 0,
  roundEndsAt: 0,
  intervalMs: DEFAULT_INTERVAL_MS,
  region: "japan_wide",
  timeLimitSeconds: 0,
  startedAt: 0,
  lastBearing: null,
};

export class GameRoom extends DurableObject<Env> {
  gameState: RoomState = { ...DEFAULT_STATE };
  /** 連打防止。メモリ上のベストエフォートで十分 */
  private lastGuessAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Durable Objectはアイドル時にメモリが揮発するため、保存された状態があれば復元する
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomState>("gameState");
      if (saved) this.gameState = { ...DEFAULT_STATE, ...saved };
    });
    // クライアントが送る "ping" にDOを起こさず自動応答する（課金とレイテンシの節約）
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async persist() {
    await this.ctx.storage.put("gameState", this.gameState);
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // ハイバネーションAPI。接続中でもDOをメモリから退避でき、再開時も切断されない
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.publicState()));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/start") && req.method === "POST") {
      const body = await this.readStartBody(req);
      if (body.mode === "classic") await this.startClassicGame(body.region, body.timeLimitSeconds, body.rounds);
      else await this.startChaseGame(body.region, body.intervalMs);
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

  private async readStartBody(req: Request) {
    const result = {
      mode: "chase" as GameMode,
      region: "japan_wide" as RegionKey,
      intervalMs: DEFAULT_INTERVAL_MS,
      timeLimitSeconds: 0,
      rounds: DEFAULT_CLASSIC_ROUNDS,
    };
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (body?.mode === "classic" || body?.mode === "chase") result.mode = body.mode;
      if (typeof body?.region === "string") result.region = body.region as RegionKey;
      if (typeof body?.intervalSeconds === "number" && Number.isFinite(body.intervalSeconds)) {
        result.intervalMs = Math.max(MIN_INTERVAL_SECONDS, Math.min(600, body.intervalSeconds)) * 1000;
      }
      if (typeof body?.timeLimitSeconds === "number" && body.timeLimitSeconds > 0) {
        result.timeLimitSeconds = Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(30, body.timeLimitSeconds));
      }
      if (typeof body?.rounds === "number" && Number.isFinite(body.rounds)) {
        result.rounds = Math.max(1, Math.min(MAX_CLASSIC_ROUNDS, Math.round(body.rounds)));
      }
    } catch {
      // ボディなし/不正なら既定値
    }
    return result;
  }

  /* ---------------------------------------------------------------- *
   * WebSocket（ハイバネーションAPIのハンドラ）
   * ---------------------------------------------------------------- */

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "guess":
        await this.handleGuess(ws, msg.lat, msg.lng, msg.userId ?? "anon", msg.playerName);
        break;
      case "hint":
        await this.revealNextHint();
        break;
      case "next":
        await this.startNextClassicRound();
        break;
      case "sync":
        ws.send(JSON.stringify(this.publicState()));
        break;
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      /* 既に閉じている */
    }
  }

  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
      /* noop */
    }
  }

  /* ---------------------------------------------------------------- *
   * 回答処理
   * ---------------------------------------------------------------- */

  async handleGuess(ws: WebSocket, lat: number, lng: number, userId: string, playerName?: string) {
    if (this.gameState.status !== "running" || !this.gameState.aiPosition) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

    const now = Date.now();
    if (now - (this.lastGuessAt.get(userId) ?? 0) < GUESS_COOLDOWN_MS) return;
    this.lastGuessAt.set(userId, now);

    const guess = { lat, lng };
    const target = this.gameState.aiPosition;
    const distanceKm = haversineKm(guess, target);

    if (this.gameState.mode === "classic") {
      await this.settleClassicRound(guess, distanceKm, false);
      await this.recordGuess(userId, playerName, guess, distanceKm, this.gameState.history.at(-1)?.score ?? 0);
      return;
    }

    // --- 逃走モード ---
    this.gameState.attempts += 1;
    const correct = distanceKm <= CORRECT_RADIUS_KM;

    if (!correct) {
      await this.persist();
      ws.send(
        JSON.stringify({
          type: "result",
          distanceKm: roundTo(distanceKm, 2),
          correct: false,
          score: 0,
          proximity: proximityBand(distanceKm),
          // 25km以内まで近づいたら方角も教える（近くまで来た人だけ詰められる）
          bearing: distanceKm <= 25 ? Math.round(bearingDeg(guess, target)) : null,
          roundOver: false,
        })
      );
      this.broadcast(this.publicState());
      await this.recordGuess(userId, playerName, guess, distanceKm, 0);
      return;
    }

    const proximityScore = Math.round(500 + 500 * (1 - distanceKm / CORRECT_RADIUS_KM));
    const score = Math.max(
      100,
      proximityScore - this.gameState.hintPenalty - Math.max(0, this.gameState.attempts - 1) * RETRY_PENALTY
    );

    this.gameState.totalScore += score;
    this.gameState.history = [
      ...this.gameState.history,
      { round: this.gameState.round, target, guess, distanceKm: roundTo(distanceKm, 2), score, caught: true },
    ];

    ws.send(
      JSON.stringify({
        type: "result",
        distanceKm: roundTo(distanceKm, 2),
        correct: true,
        score,
        proximity: "burning",
        bearing: null,
        target,
        roundOver: true,
      })
    );
    this.broadcast({ type: "caught", userId, playerName: playerName ?? null, round: this.gameState.round, score });

    await this.recordGuess(userId, playerName, guess, distanceKm, score);
    await this.advanceChaseRound();
  }

  /** 通常モード1ラウンドの決着。timeUp=true なら時間切れ */
  private async settleClassicRound(guess: LatLng | null, distanceKm: number | null, timeUp: boolean) {
    const target = this.gameState.aiPosition!;
    const score = timeUp || distanceKm === null ? 0 : classicScore(distanceKm, regionScaleKm(this.gameState.region), this.gameState.hintPenalty);

    this.gameState.totalScore += score;
    this.gameState.history = [
      ...this.gameState.history,
      {
        round: this.gameState.round,
        target,
        guess,
        distanceKm: distanceKm === null ? null : roundTo(distanceKm, 2),
        score,
        caught: distanceKm !== null && distanceKm <= CORRECT_RADIUS_KM,
      },
    ];
    this.gameState.revealedTrail = [...this.gameState.revealedTrail, target].slice(-TRAIL_LENGTH);
    this.gameState.status = this.gameState.round >= this.gameState.maxRounds ? "finished" : "reveal";

    // 回答済みなのに制限時間アラームが後から発火して結果を上書きするのを防ぐ
    await this.ctx.storage.deleteAlarm();
    await this.persist();

    this.broadcast({
      type: "result",
      distanceKm: distanceKm === null ? null : roundTo(distanceKm, 2),
      correct: distanceKm !== null && distanceKm <= CORRECT_RADIUS_KM,
      score,
      proximity: distanceKm === null ? null : proximityBand(distanceKm),
      bearing: null,
      target,
      timeUp,
      roundOver: true,
    });
    this.broadcast(this.publicState());

    if (this.gameState.status === "finished") await this.saveFinalScore();
  }

  /* ---------------------------------------------------------------- *
   * ヒント
   * ---------------------------------------------------------------- */

  async revealNextHint() {
    if (this.gameState.status !== "running") return;
    if (this.gameState.revealedHintCount >= this.gameState.allHints.length) return;

    this.gameState.revealedHintCount += 1;
    this.gameState.hintPenalty += HINT_PENALTY;
    await this.persist();
    this.broadcast(this.publicState());
  }

  /* ---------------------------------------------------------------- *
   * ゲーム進行
   * ---------------------------------------------------------------- */

  async startClassicGame(region: RegionKey, timeLimitSeconds: number, rounds: number) {
    await this.ctx.storage.deleteAlarm();
    this.gameState = {
      ...DEFAULT_STATE,
      mode: "classic",
      region,
      timeLimitSeconds,
      maxRounds: rounds,
      round: 0,
      startedAt: Date.now(),
    };
    await this.beginClassicRound();
  }

  async startNextClassicRound() {
    if (this.gameState.mode !== "classic" || this.gameState.status !== "reveal") return;
    await this.beginClassicRound();
  }

  private async beginClassicRound() {
    const spot = await findStreetPoint(this.env.MAPILLARY_TOKEN, this.gameState.region, this.gameState.trail);
    const position = spot?.point ?? randomFallbackPoint(this.gameState.region);
    const hints = await buildPlaceHints(position, this.env.SESSIONS);
    const now = Date.now();

    this.gameState = {
      ...this.gameState,
      status: "running",
      round: this.gameState.round + 1,
      aiPosition: position,
      trail: [...this.gameState.trail, position].slice(-TRAIL_LENGTH),
      imageUrl: spot?.imageUrl ?? "",
      imageId: spot?.imageId ?? "",
      isPano: spot?.isPano ?? false,
      allHints: hints,
      revealedHintCount: 0,
      hintPenalty: 0,
      attempts: 0,
      nextUpdateAt: 0,
      roundEndsAt: this.gameState.timeLimitSeconds > 0 ? now + this.gameState.timeLimitSeconds * 1000 : 0,
    };

    await this.persist();
    this.broadcast(this.publicState());

    if (this.gameState.timeLimitSeconds > 0) {
      await this.ctx.storage.setAlarm(this.gameState.roundEndsAt);
    }
  }

  async startChaseGame(region: RegionKey, intervalMs: number) {
    await this.ctx.storage.deleteAlarm();
    const spot = await findStreetPoint(this.env.MAPILLARY_TOKEN, region);
    const position = spot?.point ?? randomFallbackPoint(region);
    const hints = await buildPlaceHints(position, this.env.SESSIONS);
    const now = Date.now();

    this.gameState = {
      ...DEFAULT_STATE,
      mode: "chase",
      status: "running",
      round: 1,
      maxRounds: CHASE_ROUNDS,
      aiPosition: position,
      trail: [position],
      imageUrl: spot?.imageUrl ?? "",
      imageId: spot?.imageId ?? "",
      isPano: spot?.isPano ?? false,
      allHints: hints,
      nextUpdateAt: now + intervalMs,
      intervalMs,
      region,
      startedAt: now,
    };

    await this.persist();
    this.broadcast(this.publicState());
    await this.ctx.storage.setAlarm(this.gameState.nextUpdateAt);
  }

  async stopGame() {
    await this.ctx.storage.deleteAlarm();
    this.gameState.status = "idle";
    this.gameState.nextUpdateAt = 0;
    this.gameState.roundEndsAt = 0;
    await this.persist();
    this.broadcast(this.publicState());
  }

  async advanceChaseRound() {
    await this.ctx.storage.deleteAlarm();
    await this.moveToNextLocation();
  }

  async alarm() {
    if (this.gameState.status !== "running") return;

    if (this.gameState.mode === "classic") {
      await this.settleClassicRound(null, null, true);
      return;
    }

    // 時間内に見つけられなかったので取り逃がし扱い
    if (this.gameState.aiPosition) {
      this.gameState.history = [
        ...this.gameState.history,
        {
          round: this.gameState.round,
          target: this.gameState.aiPosition,
          guess: null,
          distanceKm: null,
          score: 0,
          caught: false,
        },
      ];
    }
    await this.moveToNextLocation();
  }

  private async moveToNextLocation() {
    if (!this.gameState.aiPosition) return;

    const previous = this.gameState.aiPosition;

    if (this.gameState.round >= this.gameState.maxRounds) {
      this.gameState.status = "finished";
      this.gameState.revealedTrail = [...this.gameState.revealedTrail, previous].slice(-TRAIL_LENGTH);
      this.gameState.nextUpdateAt = 0;
      await this.persist();
      this.broadcast(this.publicState());
      await this.saveFinalScore();
      return;
    }

    const moved = await moveAI(
      this.env.MAPILLARY_TOKEN,
      this.gameState.region,
      previous,
      this.gameState.trail,
      this.gameState.lastBearing
    );
    const position = moved?.point ?? previous;
    const hints = await buildPlaceHints(position, this.env.SESSIONS);

    this.gameState.round += 1;
    this.gameState.aiPosition = position;
    this.gameState.lastBearing = moved?.bearing ?? this.gameState.lastBearing;
    this.gameState.trail = [...this.gameState.trail, position].slice(-TRAIL_LENGTH);
    // 決着したラウンドのAI位置だけを軌跡として公開する
    this.gameState.revealedTrail = [...this.gameState.revealedTrail, previous].slice(-TRAIL_LENGTH);
    this.gameState.imageUrl = moved?.imageUrl || this.gameState.imageUrl;
    this.gameState.imageId = moved?.imageId || this.gameState.imageId;
    this.gameState.isPano = moved?.isPano ?? this.gameState.isPano;
    this.gameState.allHints = hints;
    this.gameState.revealedHintCount = 0;
    this.gameState.hintPenalty = 0;
    this.gameState.attempts = 0;
    this.gameState.nextUpdateAt = Date.now() + this.gameState.intervalMs;

    await this.persist();
    this.broadcast(this.publicState());
    await this.ctx.storage.setAlarm(this.gameState.nextUpdateAt);
  }

  /* ---------------------------------------------------------------- *
   * 永続化（D1）
   * ---------------------------------------------------------------- */

  private async recordGuess(
    userId: string,
    playerName: string | undefined,
    guess: LatLng,
    distanceKm: number,
    score: number
  ) {
    try {
      await this.env.DB.prepare(
        `INSERT INTO guesses (id, room_id, round_no, user_id, player_name, mode, region,
                              guess_lat, guess_lng, distance_km, score, guessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          this.ctx.id.toString(),
          this.gameState.round,
          userId,
          playerName ?? null,
          this.gameState.mode,
          this.gameState.region,
          guess.lat,
          guess.lng,
          distanceKm,
          score,
          Date.now()
        )
        .run();
    } catch (err) {
      console.error("D1 write failed (guesses)", err);
    }
  }

  private async saveFinalScore() {
    if (this.gameState.totalScore <= 0) return;
    try {
      await this.env.DB.prepare(
        `INSERT INTO results (id, room_id, mode, region, rounds, total_score, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          this.ctx.id.toString(),
          this.gameState.mode,
          this.gameState.region,
          this.gameState.maxRounds,
          this.gameState.totalScore,
          Date.now()
        )
        .run();
    } catch (err) {
      console.error("D1 write failed (results)", err);
    }
  }

  /* ---------------------------------------------------------------- *
   * 配信・状態
   * ---------------------------------------------------------------- */

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        try {
          ws.close(1011, "send failed");
        } catch {
          /* noop */
        }
      }
    }
  }

  publicState(): PublicState {
    const s = this.gameState;
    return {
      type: "state",
      mode: s.mode,
      status: s.status,
      round: Math.min(s.round, s.maxRounds),
      maxRounds: s.maxRounds,
      imageId: s.imageId,
      imageUrl: s.imageUrl,
      isPano: s.isPano,
      region: s.region,
      revealedHints: s.allHints.slice(0, s.revealedHintCount),
      hintsAvailable: Math.max(0, s.allHints.length - s.revealedHintCount),
      hintPenalty: s.hintPenalty,
      attempts: s.attempts,
      totalScore: s.totalScore,
      intervalSeconds: Math.round(s.intervalMs / 1000),
      timeLimitSeconds: s.timeLimitSeconds,
      nextUpdateAt: s.mode === "chase" && s.status === "running" ? s.nextUpdateAt : 0,
      roundEndsAt: s.mode === "classic" && s.status === "running" ? s.roundEndsAt : 0,
      serverNow: Date.now(),
      players: this.ctx.getWebSockets().length,
      // revealedTrail には決着済みラウンドの位置しか入れていないので、そのまま公開してよい
      revealedTrail: s.revealedTrail,
      history: s.history,
    };
  }
}

/* ------------------------------------------------------------------ *
 * スコア・判定ヘルパー
 * ------------------------------------------------------------------ */

function roundTo(value: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** GeoGuessr風の指数減衰スコア。エリアが狭いほど厳しく採点される */
function classicScore(distanceKm: number, scaleKm: number, hintPenalty: number): number {
  if (distanceKm <= 0.15) return Math.max(0, 5000 - hintPenalty);
  const raw = 5000 * Math.exp((-10 * distanceKm) / scaleKm);
  return Math.max(0, Math.round(raw) - hintPenalty);
}

function proximityBand(distanceKm: number): "burning" | "hot" | "warm" | "cold" | "freezing" {
  if (distanceKm < 1) return "burning";
  if (distanceKm < 5) return "hot";
  if (distanceKm < 25) return "warm";
  if (distanceKm < 100) return "cold";
  return "freezing";
}