import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  LatLng,
  TrailPoint,
  RegionKey,
  GameMode,
  GameStatus,
  PublicState,
  RoundRecord,
  ClientMessage,
} from "./types";
import {
  findStreetPointOnLand,
  moveAI,
  haversineKm,
  bearingDeg,
  buildPlaceHints,
  randomFallbackPoint,
  regionScaleKm,
  regionHintLevel,
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
/** 逃走判断に使う直近の回答数 */
const PURSUIT_MEMORY = 6;

/** WebSocketに紐づけるプレイヤー情報。ハイバネーションを跨いで保持される */
interface PlayerAttachment {
  playerId: string;
  joinedAt: number;
}

/** 通常モードで1人ぶんの回答 */
interface ClassicAnswer {
  guess: LatLng;
  distanceKm: number;
  score: number;
}

interface RoomState {
  mode: GameMode;
  status: GameStatus;
  round: number;
  maxRounds: number;
  runnerPosition: LatLng | null;
  trail: LatLng[];
  revealedTrail: TrailPoint[];
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
  moving: boolean;
  lastMoveAt: number;
  /** このラウンドに届いた回答座標。逃走方向の決定に使う */
  roundGuesses: LatLng[];
  /** 通常モードで、このラウンドに誰がどう答えたか */
  classicAnswers: Record<string, ClassicAnswer>;
}

const DEFAULT_STATE: RoomState = {
  mode: "chase",
  status: "idle",
  round: 0,
  maxRounds: CHASE_ROUNDS,
  runnerPosition: null,
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
  moving: false,
  lastMoveAt: 0,
  roundGuesses: [],
  classicAnswers: {},
};

export class GameRoom extends DurableObject<Env> {
  gameState: RoomState = { ...DEFAULT_STATE };
  /** 連打防止。プレイヤーごとに独立していないと、1人が答えると全員が待たされる */
  private lastGuessAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Partial<RoomState> & { aiPosition?: LatLng | null }>("gameState");
      if (!saved) return;
      this.gameState = { ...DEFAULT_STATE, ...saved };
      // 旧バージョンの保存データとの互換
      if (!this.gameState.runnerPosition && saved.aiPosition) this.gameState.runnerPosition = saved.aiPosition;
      this.gameState.revealedTrail = (this.gameState.revealedTrail ?? []).map((p: any, i) => ({
        lat: p.lat,
        lng: p.lng,
        round: typeof p.round === "number" ? p.round : i + 1,
      }));
      this.gameState.roundGuesses = this.gameState.roundGuesses ?? [];
      this.gameState.classicAnswers = this.gameState.classicAnswers ?? {};
      // 途中で落ちたときに「移動中」のまま固まらないようにする
      this.gameState.moving = false;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async persist() {
    await this.ctx.storage.put("gameState", this.gameState);
  }

  /* ---------------------------------------------------------------- *
   * ホスト管理
   *
   * いちばん先に入室した人がホスト。抜けたら次に古い人へ自動で移る。
   * 接続情報は serializeAttachment に載せてあるので、
   * Durable Object がハイバネーションから復帰しても引き継がれる。
   * ---------------------------------------------------------------- */

  private attachmentOf(ws: WebSocket): PlayerAttachment | null {
    try {
      const a = ws.deserializeAttachment() as PlayerAttachment | null;
      return a && typeof a.playerId === "string" ? a : null;
    } catch {
      return null;
    }
  }

  /** exclude を除いた中で、いちばん先に入った人のID */
  private hostId(exclude?: WebSocket): string | null {
    let best: PlayerAttachment | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = this.attachmentOf(ws);
      if (!a) continue;
      if (!best || a.joinedAt < best.joinedAt || (a.joinedAt === best.joinedAt && a.playerId < best.playerId)) {
        best = a;
      }
    }
    return best?.playerId ?? null;
  }

  private playerCount(exclude?: WebSocket): number {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) if (ws !== exclude) n++;
    return n;
  }

  /** 探索前に「移動中」を配信して、待ち時間を無反応にしない */
  private announceMoving(moving: boolean) {
    this.gameState.moving = moving;
    this.broadcast(this.publicState());
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") {
      const playerId = url.searchParams.get("pid") || crypto.randomUUID();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // 誰がいつ入ったかを覚えておく。ホストの決定に使う
      server.serializeAttachment({ playerId, joinedAt: Date.now() } satisfies PlayerAttachment);
      server.send(JSON.stringify(this.publicState()));
      // 新しい人が入ったので、全員に人数とホストを配り直す
      this.broadcast(this.publicState());
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/start") && req.method === "POST") {
      const body = await this.readStartBody(req);
      const denied = this.rejectIfNotHost(body.playerId);
      if (denied) return denied;

      if (body.mode === "classic") await this.startClassicGame(body.region, body.timeLimitSeconds, body.rounds);
      else await this.startChaseGame(body.region, body.intervalMs);
      return Response.json({ ok: true, state: this.publicState() });
    }

    if (url.pathname.endsWith("/stop") && req.method === "POST") {
      let playerId: string | undefined;
      try {
        playerId = ((await req.json()) as { playerId?: string })?.playerId;
      } catch {
        /* ボディなし */
      }
      const denied = this.rejectIfNotHost(playerId);
      if (denied) return denied;

      await this.stopGame();
      return Response.json({ ok: true, state: this.publicState() });
    }

    if (url.pathname.endsWith("/state") && req.method === "GET") {
      return Response.json(this.publicState());
    }

    return new Response("not found", { status: 404 });
  }

  /** ホスト以外の操作を弾く。誰も接続していないときは誰でも操作できる */
  private rejectIfNotHost(playerId?: string): Response | null {
    const host = this.hostId();
    if (!host) return null;
    if (playerId && playerId === host) return null;
    return Response.json(
      { ok: false, error: "ホストだけが開始・停止できます" },
      { status: 403 }
    );
  }

  private async readStartBody(req: Request) {
    const result = {
      mode: "chase" as GameMode,
      region: "japan_wide" as RegionKey,
      intervalMs: DEFAULT_INTERVAL_MS,
      timeLimitSeconds: 0,
      rounds: DEFAULT_CLASSIC_ROUNDS,
      playerId: undefined as string | undefined,
    };
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (body?.mode === "classic" || body?.mode === "chase") result.mode = body.mode;
      if (typeof body?.region === "string") result.region = body.region as RegionKey;
      if (typeof body?.playerId === "string") result.playerId = body.playerId;
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
      case "guess": {
        // 接続そのものに紐づくIDを優先する。
        // クライアント任せにすると全員が同じIDを送ってきて、
        // 連打防止が全員で共有されてしまう（実際にその不具合があった）
        const id = this.attachmentOf(ws)?.playerId ?? msg.userId ?? "anon";
        await this.handleGuess(ws, msg.lat, msg.lng, id, msg.playerName);
        break;
      }
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
    // ホストが抜けたら次の人へ引き継ぐ。抜けた本人は数に入れない
    this.broadcast(this.publicState(ws), ws);
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
    if (this.gameState.status !== "running" || !this.gameState.runnerPosition) return;
    if (this.gameState.moving) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

    const now = Date.now();
    if (now - (this.lastGuessAt.get(userId) ?? 0) < GUESS_COOLDOWN_MS) return;
    this.lastGuessAt.set(userId, now);

    const guess = { lat, lng };
    const target = this.gameState.runnerPosition;
    const distanceKm = haversineKm(guess, target);

    // 「どこから追われているか」を覚えて、次の移動方向に反映する
    this.gameState.roundGuesses = [...this.gameState.roundGuesses, guess].slice(-PURSUIT_MEMORY);

    if (this.gameState.mode === "classic") {
      await this.handleClassicGuess(ws, userId, playerName, guess, distanceKm);
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
          // 25km以内まで近づいたら方角も教える
          bearing: distanceKm <= 25 ? Math.round(bearingDeg(guess, target)) : null,
          roundOver: false,
        })
      );
      this.broadcast(this.publicState());
      this.recordGuess(userId, playerName, guess, distanceKm, 0);
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

    this.recordGuess(userId, playerName, guess, distanceKm, score);
    await this.advanceChaseRound();
  }

  /**
   * 通常モードの回答。
   *
   * 以前は1人が答えた瞬間にラウンドが決着し、他の人は回答できなかった。
   * いまは全員ぶん受け付け、接続中の全員が答えるか時間切れになるまで待つ。
   */
  private async handleClassicGuess(
    ws: WebSocket,
    userId: string,
    playerName: string | undefined,
    guess: LatLng,
    distanceKm: number
  ) {
    // 1人1回まで。答え直しは認めない
    if (this.gameState.classicAnswers[userId]) return;

    const score = classicScore(distanceKm, regionScaleKm(this.gameState.region), this.gameState.hintPenalty);
    this.gameState.classicAnswers[userId] = { guess, distanceKm, score };
    await this.persist();

    this.recordGuess(userId, playerName, guess, distanceKm, score);

    const answered = Object.keys(this.gameState.classicAnswers).length;
    const total = this.playerCount();

    if (answered < total) {
      // 本人にだけ「受理した」と返す。正解座標はまだ伏せる
      ws.send(
        JSON.stringify({
          type: "result",
          distanceKm: roundTo(distanceKm, 2),
          correct: distanceKm <= CORRECT_RADIUS_KM,
          score,
          proximity: proximityBand(distanceKm),
          bearing: null,
          roundOver: false,
          waiting: true,
        })
      );
      this.broadcast(this.publicState());
      return;
    }

    await this.settleClassicRound(false);
  }

  /**
   * 通常モード1ラウンドの決着。
   * スコアは「いちばん近かった人」の点をルームの得点として加算する。
   */
  private async settleClassicRound(timeUp: boolean) {
    const target = this.gameState.runnerPosition!;
    const answers = Object.values(this.gameState.classicAnswers);

    let best: ClassicAnswer | null = null;
    for (const a of answers) {
      if (!best || a.distanceKm < best.distanceKm) best = a;
    }

    const score = best ? best.score : 0;
    const distanceKm = best ? best.distanceKm : null;
    const guess = best ? best.guess : null;

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
    this.gameState.revealedTrail = [
      ...this.gameState.revealedTrail,
      { ...target, round: this.gameState.round },
    ].slice(-TRAIL_LENGTH);
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
    this.announceMoving(true);

    const spot = await findStreetPointOnLand(
      this.env.MAPILLARY_TOKEN,
      this.gameState.region,
      this.env.SESSIONS,
      this.gameState.trail
    );
    const position = spot?.point ?? randomFallbackPoint(this.gameState.region);
    const hints = await buildPlaceHints(position, this.env.SESSIONS, regionHintLevel(this.gameState.region));
    const now = Date.now();

    this.gameState = {
      ...this.gameState,
      status: "running",
      round: this.gameState.round + 1,
      runnerPosition: position,
      trail: [...this.gameState.trail, position].slice(-TRAIL_LENGTH),
      imageUrl: spot?.imageUrl ?? "",
      imageId: spot?.imageId ?? "",
      isPano: spot?.isPano ?? false,
      allHints: hints,
      revealedHintCount: 0,
      hintPenalty: 0,
      attempts: 0,
      roundGuesses: [],
      classicAnswers: {},
      nextUpdateAt: 0,
      roundEndsAt: this.gameState.timeLimitSeconds > 0 ? now + this.gameState.timeLimitSeconds * 1000 : 0,
      moving: false,
      lastMoveAt: now,
    };

    await this.persist();
    this.broadcast(this.publicState());

    if (this.gameState.timeLimitSeconds > 0) {
      await this.ctx.storage.setAlarm(this.gameState.roundEndsAt);
    }
  }

  async startChaseGame(region: RegionKey, intervalMs: number) {
    await this.ctx.storage.deleteAlarm();

    this.gameState = { ...DEFAULT_STATE, mode: "chase", region, intervalMs, startedAt: Date.now() };
    this.announceMoving(true);

    const spot = await findStreetPointOnLand(this.env.MAPILLARY_TOKEN, region, this.env.SESSIONS);
    const position = spot?.point ?? randomFallbackPoint(region);
    const hints = await buildPlaceHints(position, this.env.SESSIONS, regionHintLevel(region));
    const now = Date.now();

    this.gameState = {
      ...DEFAULT_STATE,
      mode: "chase",
      status: "running",
      round: 1,
      maxRounds: CHASE_ROUNDS,
      runnerPosition: position,
      trail: [position],
      imageUrl: spot?.imageUrl ?? "",
      imageId: spot?.imageId ?? "",
      isPano: spot?.isPano ?? false,
      allHints: hints,
      nextUpdateAt: now + intervalMs,
      intervalMs,
      region,
      startedAt: now,
      moving: false,
      lastMoveAt: now,
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
    this.gameState.moving = false;
    await this.persist();
    this.broadcast(this.publicState());
  }

  async advanceChaseRound() {
    await this.ctx.storage.deleteAlarm();
    await this.moveToNextLocation();
  }

  async alarm() {
    if (this.gameState.status !== "running") return;
    if (this.gameState.moving) return;

    if (this.gameState.mode === "classic") {
      // 時間切れ。まだ答えていない人がいても、その時点の回答で決着させる
      await this.settleClassicRound(true);
      return;
    }

    // 時間内に見つけられなかったので取り逃がし扱い
    if (this.gameState.runnerPosition) {
      this.gameState.history = [
        ...this.gameState.history,
        {
          round: this.gameState.round,
          target: this.gameState.runnerPosition,
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
    if (!this.gameState.runnerPosition) return;

    const previous = this.gameState.runnerPosition;
    const previousRound = this.gameState.round;

    if (this.gameState.round >= this.gameState.maxRounds) {
      this.gameState.status = "finished";
      this.gameState.revealedTrail = [
        ...this.gameState.revealedTrail,
        { ...previous, round: previousRound },
      ].slice(-TRAIL_LENGTH);
      this.gameState.nextUpdateAt = 0;
      this.gameState.moving = false;
      await this.persist();
      this.broadcast(this.publicState());
      await this.saveFinalScore();
      return;
    }

    // 探索は最悪で十数秒かかる。先に「移動中」と軌跡の追加を配信しておく
    this.gameState.revealedTrail = [
      ...this.gameState.revealedTrail,
      { ...previous, round: previousRound },
    ].slice(-TRAIL_LENGTH);
    this.gameState.nextUpdateAt = 0;
    this.announceMoving(true);

    const moved = await moveAI(
      this.env.MAPILLARY_TOKEN,
      this.gameState.region,
      previous,
      this.gameState.trail,
      this.gameState.lastBearing,
      this.gameState.roundGuesses,
      this.env.SESSIONS
    );
    const position = moved?.point ?? previous;
    const hints = await buildPlaceHints(position, this.env.SESSIONS, regionHintLevel(this.gameState.region));

    this.gameState.round += 1;
    this.gameState.runnerPosition = position;
    this.gameState.lastBearing = moved?.bearing ?? this.gameState.lastBearing;
    this.gameState.trail = [...this.gameState.trail, position].slice(-TRAIL_LENGTH);
    this.gameState.imageUrl = moved?.imageUrl || this.gameState.imageUrl;
    this.gameState.imageId = moved?.imageId || this.gameState.imageId;
    this.gameState.isPano = moved?.isPano ?? this.gameState.isPano;
    this.gameState.allHints = hints;
    this.gameState.revealedHintCount = 0;
    this.gameState.hintPenalty = 0;
    this.gameState.attempts = 0;
    this.gameState.roundGuesses = [];
    this.gameState.classicAnswers = {};
    this.gameState.moving = false;
    this.gameState.lastMoveAt = Date.now();
    this.gameState.nextUpdateAt = this.gameState.lastMoveAt + this.gameState.intervalMs;

    await this.persist();
    this.broadcast(this.publicState());
    await this.ctx.storage.setAlarm(this.gameState.nextUpdateAt);
  }

  /* ---------------------------------------------------------------- *
   * 永続化（D1）
   * ---------------------------------------------------------------- */

  /** 待たずに投げる。失敗してもゲーム進行は止めない */
  private recordGuess(
    userId: string,
    playerName: string | undefined,
    guess: LatLng,
    distanceKm: number,
    score: number
  ) {
    this.env.DB.prepare(
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
      .run()
      .catch((err: unknown) => console.error("D1 write failed (guesses)", err));
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

  broadcast(msg: unknown, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
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

  publicState(exclude?: WebSocket): PublicState {
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
      nextUpdateAt: s.mode === "chase" && s.status === "running" && !s.moving ? s.nextUpdateAt : 0,
      roundEndsAt: s.mode === "classic" && s.status === "running" && !s.moving ? s.roundEndsAt : 0,
      serverNow: Date.now(),
      players: this.playerCount(exclude),
      hostId: this.hostId(exclude),
      answered: Object.keys(s.classicAnswers).length,
      moving: s.moving,
      lastMoveAt: s.lastMoveAt,
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