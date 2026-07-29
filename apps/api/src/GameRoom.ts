import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  LatLng,
  TrailPoint,
  RegionKey,
  GameMode,
  GameStatus,
  PublicState,
  PlayerScore,
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
/** 順位表に載せる人数の上限 */
const SCOREBOARD_LIMIT = 30;

/** WebSocketに紐づけるプレイヤー情報。ハイバネーションを跨いで保持される */
interface PlayerAttachment {
  playerId: string;
  name: string | null;
  joinedAt: number;
}

/** 通常モードで1人ぶんの回答 */
interface ClassicAnswer {
  name: string | null;
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
  /** プレイヤーごとの累計成績。順位はここから作る */
  scoreboard: Record<string, PlayerScore>;
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
  scoreboard: {},
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
      this.gameState.scoreboard = this.gameState.scoreboard ?? {};
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

  /** いま接続しているプレイヤーIDの集合 */
  private onlineIds(exclude?: WebSocket): Set<string> {
    const set = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = this.attachmentOf(ws);
      if (a) set.add(a.playerId);
    }
    return set;
  }

  /** ホストでなければ true を返し、本人に理由を伝える */
  private denyIfNotHost(ws: WebSocket, action: string): boolean {
    const host = this.hostId();
    if (!host) return false; // 誰もいなければ制限しない
    const me = this.attachmentOf(ws)?.playerId;
    if (me === host) return false;
    try {
      ws.send(JSON.stringify({ type: "notice", message: `ホストだけが${action}できます` }));
    } catch {
      /* 送信できなくても進行に影響はない */
    }
    return true;
  }

  /** 探索前に「移動中」を配信して、待ち時間を無反応にしない */
  private announceMoving(moving: boolean) {
    this.gameState.moving = moving;
    this.broadcast(this.publicState());
  }

  /* ---------------------------------------------------------------- *
   * 成績（プレイヤーごと）
   * ---------------------------------------------------------------- */

  private ensurePlayer(id: string, name?: string | null): PlayerScore {
    const existing = this.gameState.scoreboard[id];
    if (existing) {
      if (name && existing.name !== name) existing.name = name;
      return existing;
    }
    const created: PlayerScore = {
      id,
      name: name ?? null,
      total: 0,
      lastRound: 0,
      answered: 0,
      bestKm: null,
      online: true,
    };
    this.gameState.scoreboard[id] = created;
    return created;
  }

  /** 距離から出した点をその人だけに加算する */
  private awardScore(id: string, name: string | null | undefined, score: number, distanceKm: number | null) {
    const p = this.ensurePlayer(id, name);
    p.total += score;
    p.lastRound = score;
    p.answered += 1;
    if (distanceKm !== null && (p.bestKm === null || distanceKm < p.bestKm)) p.bestKm = distanceKm;
  }

  /** 外れた回答。点は入らないが「どこまで近づけたか」は残す */
  private noteAttempt(id: string, name: string | null | undefined, distanceKm: number) {
    const p = this.ensurePlayer(id, name);
    if (p.bestKm === null || distanceKm < p.bestKm) p.bestKm = distanceKm;
  }

  /** 新しいラウンドに入るとき、直近ラウンドの点だけ消す（累計は残す） */
  private resetRoundScores() {
    for (const p of Object.values(this.gameState.scoreboard)) p.lastRound = 0;
  }

  /** 累計スコア順。同点なら最短距離が近い人を上に */
  private scoreboardList(exclude?: WebSocket): PlayerScore[] {
    const online = this.onlineIds(exclude);
    return Object.values(this.gameState.scoreboard)
      .map((p) => ({ ...p, online: online.has(p.id) }))
      .sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        const ak = a.bestKm ?? Infinity;
        const bk = b.bestKm ?? Infinity;
        return ak - bk;
      })
      .slice(0, SCOREBOARD_LIMIT);
  }

  /** ルームの代表スコア = 最高得点者の累計 */
  private roomTopScore(): number {
    let top = 0;
    for (const p of Object.values(this.gameState.scoreboard)) if (p.total > top) top = p.total;
    return top;
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") {
      const playerId = url.searchParams.get("pid") || crypto.randomUUID();
      const name = url.searchParams.get("name")?.slice(0, 20) || null;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // 誰がいつ入ったかを覚えておく。ホストの決定に使う
      server.serializeAttachment({ playerId, name, joinedAt: Date.now() } satisfies PlayerAttachment);

      // 回答前でも順位表に名前が出るよう、入室時点で登録しておく
      this.ensurePlayer(playerId, name);

      server.send(JSON.stringify(this.publicState()));
      // 新しい人が入ったので、全員に人数とホストを配り直す
      this.broadcast(this.publicState());
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/start") && req.method === "POST") {
      const body = await this.readStartBody(req);
      const denied = this.rejectIfNotHost(body.playerId, "開始");
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
      const denied = this.rejectIfNotHost(playerId, "停止");
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
  private rejectIfNotHost(playerId: string | undefined, action: string): Response | null {
    const host = this.hostId();
    if (!host) return null;
    if (playerId && playerId === host) return null;
    return Response.json({ ok: false, error: `ホストだけが${action}できます` }, { status: 403 });
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

    const attachment = this.attachmentOf(ws);

    switch (msg.type) {
      case "guess": {
        // 接続そのものに紐づくIDを優先する。
        // クライアント任せにすると全員が同じIDを送ってきて、
        // 連打防止が全員で共有されてしまう（実際にその不具合があった）
        const id = attachment?.playerId ?? msg.userId ?? "anon";
        const name = msg.playerName ?? attachment?.name ?? null;
        await this.handleGuess(ws, msg.lat, msg.lng, id, name);
        break;
      }

      case "hint":
        // ヒントは全員に公開され、減点も全員に等しくかかる。
        // 順位は同じ条件で競うことになるので、誰が開いてもよい
        await this.revealNextHint();
        break;

      case "next":
        // 次のラウンドへ進めるのはホストだけ
        if (this.denyIfNotHost(ws, "次のラウンドへ進む")) return;
        await this.startNextClassicRound();
        break;

      case "rename": {
        const id = attachment?.playerId;
        const name = String(msg.playerName ?? "").slice(0, 20).trim() || null;
        if (!id) return;
        ws.serializeAttachment({ ...attachment!, name });
        this.ensurePlayer(id, name);
        await this.persist();
        this.broadcast(this.publicState());
        break;
      }

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

  async handleGuess(ws: WebSocket, lat: number, lng: number, userId: string, playerName: string | null) {
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

    /* --- 逃走モード ---
       見つけた人だけに点が入る。外した人も「最短距離」だけ記録しておく */
    this.gameState.attempts += 1;
    const correct = distanceKm <= CORRECT_RADIUS_KM;

    if (!correct) {
      this.noteAttempt(userId, playerName, distanceKm);
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

    this.awardScore(userId, playerName, score, distanceKm);
    this.gameState.totalScore = this.roomTopScore();
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
    this.broadcast({ type: "caught", userId, playerName, round: this.gameState.round, score });

    this.recordGuess(userId, playerName, guess, distanceKm, score);
    await this.advanceChaseRound();
  }

  /**
   * 通常モードの回答。
   *
   * 点数は回答者ごとに独立して計算する（同じ地点でも、置いたピンが近い人ほど高い）。
   * 全員が答えるか時間切れになるまでラウンドは終わらない。
   */
  private async handleClassicGuess(
    ws: WebSocket,
    userId: string,
    playerName: string | null,
    guess: LatLng,
    distanceKm: number
  ) {
    // 1人1回まで。答え直しは認めない
    if (this.gameState.classicAnswers[userId]) return;

    const score = classicScore(distanceKm, regionScaleKm(this.gameState.region), this.gameState.hintPenalty);
    this.gameState.classicAnswers[userId] = { name: playerName, guess, distanceKm, score };
    this.ensurePlayer(userId, playerName);
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
   * 回答した全員に、それぞれの距離で計算した点を配る。
   */
  private async settleClassicRound(timeUp: boolean) {
    const target = this.gameState.runnerPosition!;
    const entries = Object.entries(this.gameState.classicAnswers);

    // 回答者それぞれに、その人の距離から出した点を加算する
    for (const [id, ans] of entries) {
      this.awardScore(id, ans.name, ans.score, ans.distanceKm);
    }

    // 記録パネル用に「そのラウンドでいちばん近かった回答」を残す
    let best: ClassicAnswer | null = null;
    for (const [, ans] of entries) {
      if (!best || ans.distanceKm < best.distanceKm) best = ans;
    }

    this.gameState.totalScore = this.roomTopScore();
    this.gameState.history = [
      ...this.gameState.history,
      {
        round: this.gameState.round,
        target,
        guess: best ? best.guess : null,
        distanceKm: best ? roundTo(best.distanceKm, 2) : null,
        score: best ? best.score : 0,
        caught: Boolean(best && best.distanceKm <= CORRECT_RADIUS_KM),
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
      distanceKm: best ? roundTo(best.distanceKm, 2) : null,
      correct: Boolean(best && best.distanceKm <= CORRECT_RADIUS_KM),
      score: best ? best.score : 0,
      proximity: best ? proximityBand(best.distanceKm) : null,
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
      // 新しいゲームなので順位もリセットする
      scoreboard: {},
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

    this.resetRoundScores();

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

    this.gameState = { ...DEFAULT_STATE, mode: "chase", region, intervalMs, startedAt: Date.now(), scoreboard: {} };
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
      scoreboard: {},
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

    this.resetRoundScores();

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
    playerName: string | null | undefined,
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
    const top = this.roomTopScore();
    if (top <= 0) return;
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
          top,
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
      totalScore: this.roomTopScore(),
      intervalSeconds: Math.round(s.intervalMs / 1000),
      timeLimitSeconds: s.timeLimitSeconds,
      nextUpdateAt: s.mode === "chase" && s.status === "running" && !s.moving ? s.nextUpdateAt : 0,
      roundEndsAt: s.mode === "classic" && s.status === "running" && !s.moving ? s.roundEndsAt : 0,
      serverNow: Date.now(),
      players: this.playerCount(exclude),
      hostId: this.hostId(exclude),
      answered: Object.keys(s.classicAnswers).length,
      scoreboard: this.scoreboardList(exclude),
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