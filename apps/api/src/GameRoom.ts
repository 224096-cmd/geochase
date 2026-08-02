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
  StreetSpot,
} from "./types";
import {
  fetchSpotForImage,
  findStreetPointOnLand,
  setRailAssets,
  moveAI,
  nearestImage,
  haversineKm,
  bearingDeg,
  buildPlaceHints,
  randomFallbackPoint,
  regionScaleKm,
  regionHintLevel,
  regionLabel,
  SearchBudget,
} from "./mapillary";

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_SECONDS = 10;
const MAX_TIME_LIMIT_SECONDS = 2700;
// search/duel: 場所選びの猶予。過ぎたら自動で決めて進行を止めない
const SETUP_TIMEOUT_MS = 60_000;
// Search & Chase: 逃走者が1回の移動で進める上限(シークバーでの大ワープ防止)
const MOVE_CAP_KM = 2.5;
// Search & Chase: 行き止まり脱出用「地図ジャンプ」の1ラウンド上限
const SEARCH_JUMPS_PER_ROUND = 2;
// 対決: この距離以内で当てたら即勝利
const DUEL_FIND_KM = 0.5;
const DUEL_FIND_BONUS = 1500;
const DUEL_WIN_BONUS = 800;
const CORRECT_RADIUS_KM = 0.5;
const CHASE_ROUNDS = 8;
const DEFAULT_CLASSIC_ROUNDS = 5;
const MAX_CLASSIC_ROUNDS = 10;
const TRAIL_LENGTH = 12;
const HINT_PENALTY = 250;
const RETRY_PENALTY = 60;
const GUESS_COOLDOWN_MS = 1500;
const PURSUIT_MEMORY = 6;
const SCOREBOARD_LIMIT = 30;

interface PlayerAttachment {
  playerId: string;
  name: string | null;
  joinedAt: number;
}

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
  /** Search & Chase: 逃走役のプレイヤーID */
  runnerId: string | null;
  /** Search & Chase: このラウンドで逃走者が使える残り移動回数(旧仕様互換。常に0) */
  relocationsLeft: number;
  /** search/duel の進行段階 */
  phase: "setup" | "live" | null;
  /** 対決: 各プレイヤーが選んだ隠れ場所 */
  duel: Record<string, { spot: StreetSpot }> | null;
  /** 対決: 開始時に確定した参加者2名(途中参加の割り込み防止) */
  duelPlayers: string[] | null;
  /** Search & Chase: 行き止まり脱出用の地図ジャンプ残り回数 */
  searchJumpsLeft: number;
  trail: LatLng[];
  revealedTrail: TrailPoint[];
  imageUrl: string;
  imageId: string;
  isPano: boolean;
  compassAngle: number | null;
  imageMissing: boolean;
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
  regionUsed: RegionKey;
  timeLimitSeconds: number;
  startedAt: number;
  lastBearing: number | null;
  moving: boolean;
  lastMoveAt: number;
  roundGuesses: LatLng[];
  classicAnswers: Record<string, ClassicAnswer>;
  scoreboard: Record<string, PlayerScore>;
}

const DEFAULT_STATE: RoomState = {
  mode: "chase",
  status: "idle",
  round: 0,
  maxRounds: CHASE_ROUNDS,
  runnerPosition: null,
  runnerId: null,
  relocationsLeft: 0,
  phase: null,
  duel: null,
  duelPlayers: null,
  searchJumpsLeft: 0,
  trail: [],
  revealedTrail: [],
  imageUrl: "",
  imageId: "",
  isPano: false,
  compassAngle: null,
  imageMissing: false,
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
  regionUsed: "japan_wide",
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
  private lastGuessAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    setRailAssets(env.RAIL);
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Partial<RoomState> & { aiPosition?: LatLng | null }>("gameState");
      if (!saved) return;
      this.gameState = { ...DEFAULT_STATE, ...saved };
      if (!this.gameState.runnerPosition && saved.aiPosition) this.gameState.runnerPosition = saved.aiPosition;
      this.gameState.revealedTrail = (this.gameState.revealedTrail ?? []).map((p: any, i) => ({
        lat: p.lat,
        lng: p.lng,
        round: typeof p.round === "number" ? p.round : i + 1,
      }));
      this.gameState.roundGuesses = this.gameState.roundGuesses ?? [];
      this.gameState.classicAnswers = this.gameState.classicAnswers ?? {};
      this.gameState.scoreboard = this.gameState.scoreboard ?? {};
      this.gameState.regionUsed = this.gameState.regionUsed ?? this.gameState.region;
      this.gameState.moving = false;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async persist() {
    await this.ctx.storage.put("gameState", this.gameState);
  }

  private attachmentOf(ws: WebSocket): PlayerAttachment | null {
    try {
      const a = ws.deserializeAttachment() as PlayerAttachment | null;
      return a && typeof a.playerId === "string" ? a : null;
    } catch {
      return null;
    }
  }

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

  private rosterList(): { id: string; name: string | null }[] {
    const map = new Map<string, string | null>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachmentOf(ws);
      if (!a) continue;
      const known = map.get(a.playerId);
      map.set(a.playerId, a.name ?? known ?? this.gameState.scoreboard[a.playerId]?.name ?? null);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }

  private onlineIds(exclude?: WebSocket): Set<string> {
    const set = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = this.attachmentOf(ws);
      if (a) set.add(a.playerId);
    }
    return set;
  }

  private denyIfNotHost(ws: WebSocket, action: string): boolean {
    const host = this.hostId();
    if (!host) return false;
    const me = this.attachmentOf(ws)?.playerId;
    if (me === host) return false;
    try {
      ws.send(JSON.stringify({ type: "notice", message: `ホストだけが${action}できます` }));
    } catch {}
    return true;
  }

  private announceMoving(moving: boolean) {
    this.gameState.moving = moving;
    this.broadcast(this.publicState());
  }

  private playerLabel(id: string): string {
    const inBoard = this.gameState.scoreboard[id]?.name;
    if (inBoard) return inBoard;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachmentOf(ws);
      if (a?.playerId === id && a.name) return a.name;
    }
    return "名無しの逃走者";
  }

  /** 特定の接続にだけ通知を出す(操作エラーの案内など) */
  private tell(ws: WebSocket, message: string) {
    try {
      ws.send(JSON.stringify({ type: "notice", message }));
    } catch {}
  }

  private notice(message: string) {
    this.broadcast({ type: "notice", message });
  }

  // 画像なしのラウンドを作らない。見つからなければ広いエリアへ逃がし、
  // それでも駄目なときだけ imageMissing を立てて理由を伝える
  private async resolveSpot(region: RegionKey, avoid: LatLng[]): Promise<{ spot: StreetSpot | null; region: RegionKey }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = new SearchBudget();
      const found = await findStreetPointOnLand(this.env.MAPILLARY_TOKEN, region, this.env.SESSIONS, avoid, budget);
      if (found?.spot?.imageId) {
        if (found.region !== region) {
          this.notice(
            `${regionLabel(region)}で車載の360°画像が見つからなかったため、${regionLabel(found.region)}まで範囲を広げました`
          );
        }
        return { spot: found.spot, region: found.region };
      }
    }
    return { spot: null, region };
  }

  private applySpot(spot: StreetSpot | null, position: LatLng) {
    this.gameState.runnerPosition = position;
    this.gameState.imageUrl = spot?.imageUrl ?? "";
    this.gameState.imageId = spot?.imageId ?? "";
    this.gameState.isPano = spot?.isPano ?? false;
    this.gameState.compassAngle = spot?.compassAngle ?? null;
    this.gameState.imageMissing = !spot?.imageId;
  }

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

  private awardScore(id: string, name: string | null | undefined, score: number, distanceKm: number | null) {
    const p = this.ensurePlayer(id, name);
    p.total += score;
    p.lastRound = score;
    p.answered += 1;
    if (distanceKm !== null && (p.bestKm === null || distanceKm < p.bestKm)) p.bestKm = distanceKm;
  }

  private noteAttempt(id: string, name: string | null | undefined, distanceKm: number) {
    const p = this.ensurePlayer(id, name);
    if (p.bestKm === null || distanceKm < p.bestKm) p.bestKm = distanceKm;
  }

  private resetRoundScores() {
    for (const p of Object.values(this.gameState.scoreboard)) p.lastRound = 0;
  }

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

  private roomTopScore(): number {
    let top = 0;
    for (const p of Object.values(this.gameState.scoreboard)) if (p.total > top) top = p.total;
    return top;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") {
      const playerId = url.searchParams.get("pid") || crypto.randomUUID();
      const name = url.searchParams.get("name")?.slice(0, 20) || null;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ playerId, name, joinedAt: Date.now() } satisfies PlayerAttachment);

      this.ensurePlayer(playerId, name);

      server.send(JSON.stringify(this.publicState()));
      this.broadcast(this.publicState());
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/start") && req.method === "POST") {
      const body = await this.readStartBody(req);
      const denied = this.rejectIfNotHost(body.playerId, "開始");
      if (denied) return denied;

      if (body.mode === "search" && this.onlineIds().size < 2) {
        return Response.json(
          { ok: false, error: "Search & Chase は2人以上で遊べます（友達を招待してください）" },
          { status: 400 }
        );
      }
      if (body.mode === "duel" && body.timeLimitSeconds <= 0) {
        body.timeLimitSeconds = 600; // 対決の「制限なし」は10分として扱う(永久戦の防止)
      }
      if (body.mode === "duel" && this.onlineIds().size !== 2) {
        return Response.json(
          { ok: false, error: "対決モードはちょうど2人で遊びます（今は" + this.onlineIds().size + "人）" },
          { status: 400 }
        );
      }
      if (body.mode === "chase") await this.startChaseGame(body.region, body.intervalMs);
      else await this.startClassicGame(body.mode, body.region, body.timeLimitSeconds, body.rounds, body.runnerId);
      return Response.json({ ok: true, state: this.publicState() });
    }

    if (url.pathname.endsWith("/stop") && req.method === "POST") {
      let playerId: string | undefined;
      try {
        playerId = ((await req.json()) as { playerId?: string })?.playerId;
      } catch {}
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
      runnerId: undefined as string | undefined,
    };
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (body?.mode === "classic" || body?.mode === "chase" || body?.mode === "search" || body?.mode === "duel") result.mode = body.mode;
      if (typeof body?.region === "string") result.region = body.region as RegionKey;
      if (typeof body?.playerId === "string") result.playerId = body.playerId;
      if (typeof body?.runnerId === "string" && body.runnerId.length <= 64) result.runnerId = body.runnerId;
      if (typeof body?.intervalSeconds === "number" && Number.isFinite(body.intervalSeconds)) {
        result.intervalMs = Math.max(MIN_INTERVAL_SECONDS, Math.min(600, body.intervalSeconds)) * 1000;
      }
      if (typeof body?.timeLimitSeconds === "number" && body.timeLimitSeconds > 0) {
        result.timeLimitSeconds = Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(30, body.timeLimitSeconds));
      }
      if (typeof body?.rounds === "number" && Number.isFinite(body.rounds)) {
        result.rounds = Math.max(1, Math.min(MAX_CLASSIC_ROUNDS, Math.round(body.rounds)));
      }
    } catch {}
    return result;
  }

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
        // 接続に紐づくIDを優先する。クライアント任せだと連打防止が全員で共有される
        const id = attachment?.playerId ?? msg.userId ?? "anon";
        const name = msg.playerName ?? attachment?.name ?? null;
        await this.handleGuess(ws, msg.lat, msg.lng, id, name);
        break;
      }

      case "hint":
        await this.revealNextHint();
        break;

      case "place": {
        const id = attachment?.playerId ?? msg.userId ?? "";
        await this.handlePlace(ws, id, msg.lat, msg.lng);
        break;
      }

      case "relocate": {
        const id = attachment?.playerId ?? msg.userId ?? "";
        await this.handleRelocate(ws, id, msg.lat, msg.lng, msg.imageId);
        break;
      }

      case "jump": {
        const id = attachment?.playerId ?? msg.userId ?? "";
        await this.handleJump(ws, id, msg.lat, msg.lng);
        break;
      }

      case "next":
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

      case "sync": {
        ws.send(JSON.stringify(this.publicState()));
        if (attachment?.playerId === this.gameState.runnerId) this.pushRunnerPosition();
        const pid = attachment?.playerId;
        if (this.gameState.mode === "duel" && pid) {
          if (this.gameState.phase === "live") this.sendDuelPuzzles(ws);
          else if (this.gameState.phase === "setup" && this.gameState.duel?.[pid]) {
            try {
              ws.send(JSON.stringify({ type: "placed" }));
            } catch {}
          }
        }
        break;
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {}
    this.broadcast(this.publicState(ws), ws);
  }

  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {}
  }

  async handleGuess(ws: WebSocket, lat: number, lng: number, userId: string, playerName: string | null) {
    if (this.gameState.status !== "running" || !this.gameState.runnerPosition) return;
    if (this.gameState.moving) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

    const now = Date.now();
    if (now - (this.lastGuessAt.get(userId) ?? 0) < GUESS_COOLDOWN_MS) return;
    this.lastGuessAt.set(userId, now);

    if (
      (this.gameState.mode === "search" || this.gameState.mode === "duel") &&
      this.gameState.phase !== "live"
    ) {
      this.tell(ws, "まだ場所選びの最中です。少し待ってください");
      return;
    }

    if (this.gameState.mode === "duel") {
      await this.handleDuelGuess(ws, userId, playerName ?? null, { lat, lng });
      return;
    }

    if (this.gameState.mode === "search" && userId === this.gameState.runnerId) {
      ws.send(
        JSON.stringify({
          type: "result",
          distanceKm: null,
          correct: false,
          score: 0,
          proximity: null,
          bearing: null,
          roundOver: false,
          runnerBlocked: true,
        })
      );
      return;
    }

    const guess = { lat, lng };
    const target = this.gameState.runnerPosition;
    const distanceKm = haversineKm(guess, target);

    this.gameState.roundGuesses = [...this.gameState.roundGuesses, guess].slice(-PURSUIT_MEMORY);

    if (this.gameState.mode === "classic") {
      await this.handleClassicGuess(ws, userId, playerName, guess, distanceKm);
      return;
    }

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
   * 対決: 相手の隠れ場所への回答。クールダウン付きで何度でも試せる早探しレース。
   * 0.5km以内に入れた瞬間その人の勝ち。時間切れなら「最も近づけた記録」で勝敗。
   */
  private async handleDuelGuess(ws: WebSocket, userId: string, playerName: string | null, guess: LatLng) {
    const s = this.gameState;
    if (!s.duel) return;
    const ids = Object.keys(s.duel);
    if (!ids.includes(userId)) {
      this.tell(ws, "この対決の参加者ではありません");
      return;
    }

    const now = Date.now();
    if (now - (this.lastGuessAt.get(userId) ?? 0) < GUESS_COOLDOWN_MS) return;
    this.lastGuessAt.set(userId, now);

    const oppId = ids.find((x) => x !== userId)!;
    const target = s.duel[oppId].spot.point;
    const distanceKm = haversineKm(guess, target);
    this.ensurePlayer(userId, playerName);
    s.attempts += 1;

    // 相手への接近警告(5kmラインを初めて跨いだときだけ)
    const prevForWarn = s.classicAnswers[userId];
    if (distanceKm <= 5 && (!prevForWarn || prevForWarn.distanceKm > 5)) {
      for (const wsx of this.ctx.getWebSockets()) {
        if (this.attachmentOf(wsx)?.playerId === oppId) {
          this.tell(wsx, "⚠ 相手があなたの隠れ場所の5km以内に接近している！");
        }
      }
    }

    // 自己ベストを更新(時間切れ時の勝敗判定に使う)
    const prev = s.classicAnswers[userId];
    if (!prev || distanceKm < prev.distanceKm) {
      const bestScore = classicScore(distanceKm, regionScaleKm(s.regionUsed), 0);
      s.classicAnswers[userId] = { name: playerName, guess, distanceKm, score: bestScore };
    }

    if (distanceKm <= DUEL_FIND_KM) {
      this.recordGuess(userId, playerName, guess, distanceKm, s.classicAnswers[userId].score);
      await this.settleDuel(false, userId);
      return;
    }

    this.recordGuess(userId, playerName, guess, distanceKm, 0);
    await this.persist();
    ws.send(
      JSON.stringify({
        type: "result",
        distanceKm: roundTo(distanceKm, 2),
        correct: false,
        score: 0,
        proximity: proximityBand(distanceKm),
        bearing: distanceKm <= 25 ? Math.round(bearingDeg(guess, target)) : null,
        roundOver: false,
      })
    );
    this.broadcast(this.publicState());
  }

  /** 対決の決着。instantWinner が居れば即勝利、いなければ距離の近い方が勝ち */
  private async settleDuel(timeUp: boolean, instantWinner: string | null) {
    const s = this.gameState;
    if (!s.duel) return;
    const ids = Object.keys(s.duel);

    // 勝者判定: 発見者が最優先。いなければ「最も近づけた記録」の勝負
    let winner: string | null = instantWinner;
    if (!winner) {
      const tried = ids.filter((id) => s.classicAnswers[id]);
      if (tried.length === 1) winner = tried[0];
      else if (tried.length === 2) {
        const [a, b] = tried;
        const da = s.classicAnswers[a].distanceKm;
        const db = s.classicAnswers[b].distanceKm;
        winner = da < db ? a : db < da ? b : null;
      }
    }

    for (const id of ids) {
      const ans = s.classicAnswers[id];
      if (ans) this.awardScore(id, ans.name, ans.score, ans.distanceKm);
    }
    if (winner) {
      const bonus = instantWinner ? DUEL_FIND_BONUS : DUEL_WIN_BONUS;
      this.awardScore(winner, this.playerLabel(winner), bonus, null);
      this.notice(
        instantWinner
          ? `🏆 ${this.playerLabel(winner)} が相手の隠れ場所を発見！ +${bonus}点`
          : `🏆 このラウンドは ${this.playerLabel(winner)} の勝ち！（最接近記録がより近い） +${bonus}点`
      );
    } else {
      this.notice(timeUp ? "⌛ 時間切れ。このラウンドは引き分け" : "🤝 このラウンドは引き分け");
    }

    s.totalScore = this.roomTopScore();
    const winAns = winner ? s.classicAnswers[winner] : null;
    const winTarget = winner ? s.duel[ids.find((x) => x !== winner)!].spot.point : s.duel[ids[0]].spot.point;
    s.history = [
      ...s.history,
      {
        round: s.round,
        target: winTarget,
        guess: winAns?.guess ?? null,
        distanceKm: winAns ? roundTo(winAns.distanceKm, 2) : null,
        score: winAns?.score ?? 0,
        caught: Boolean(instantWinner),
      },
    ];
    s.status = s.round >= s.maxRounds ? "finished" : "reveal";

    await this.ctx.storage.deleteAlarm();
    await this.persist();

    // 各自に「自分が探していた場所」を正解として返す
    for (const wsx of this.ctx.getWebSockets()) {
      const pid = this.attachmentOf(wsx)?.playerId;
      if (!pid || !ids.includes(pid)) continue;
      const opp = ids.find((x) => x !== pid)!;
      const myAns = s.classicAnswers[pid];
      try {
        wsx.send(
          JSON.stringify({
            type: "result",
            distanceKm: myAns ? roundTo(myAns.distanceKm, 2) : null,
            correct: Boolean(myAns && myAns.distanceKm <= DUEL_FIND_KM),
            score: myAns?.score ?? 0,
            proximity: myAns ? proximityBand(myAns.distanceKm) : null,
            bearing: null,
            target: s.duel![opp].spot.point,
            timeUp,
            roundOver: true,
          })
        );
      } catch {}
    }
    this.broadcast(this.publicState());
    if (s.status === "finished") await this.saveFinalScore();
  }

  private async handleClassicGuess(
    ws: WebSocket,
    userId: string,
    playerName: string | null,
    guess: LatLng,
    distanceKm: number
  ) {
    if (this.gameState.classicAnswers[userId]) return;

    const score = classicScore(distanceKm, regionScaleKm(this.gameState.regionUsed), this.gameState.hintPenalty);
    this.gameState.classicAnswers[userId] = { name: playerName, guess, distanceKm, score };
    this.ensurePlayer(userId, playerName);
    await this.persist();

    this.recordGuess(userId, playerName, guess, distanceKm, score);

    const answered = Object.keys(this.gameState.classicAnswers).length;
    const total =
      this.gameState.mode === "search" ? Math.max(1, this.playerCount() - 1) : this.playerCount();

    if (answered < total) {
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

  private async settleClassicRound(timeUp: boolean) {
    const target = this.gameState.runnerPosition!;
    const entries = Object.entries(this.gameState.classicAnswers);

    for (const [id, ans] of entries) {
      this.awardScore(id, ans.name, ans.score, ans.distanceKm);
    }

    let best: ClassicAnswer | null = null;
    for (const [, ans] of entries) {
      if (!best || ans.distanceKm < best.distanceKm) best = ans;
    }

    // Search & Chase: 逃走者は「追手の平均点が低いほど」高得点。
    // 誰も回答しなかった(全員時間切れ)ラウンドは満点で逃げ切り
    if (this.gameState.mode === "search" && this.gameState.runnerId) {
      const mean =
        entries.length > 0
          ? entries.reduce((sum, [, a]) => sum + a.score, 0) / entries.length
          : 0;
      const runnerScore = Math.max(0, 5000 - Math.round(mean));
      this.awardScore(this.gameState.runnerId, this.playerLabel(this.gameState.runnerId), runnerScore, null);
      this.notice(
        `👣 逃走者 ${this.playerLabel(this.gameState.runnerId)} は +${runnerScore}点（追手の平均 ${Math.round(mean)}点）`
      );
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

  /** 場所選びの猶予切れ。放置されてもゲームが進むよう自動で決める */
  private async resolveSetupTimeout() {
    const s = this.gameState;
    if (s.phase !== "setup") return;
    this.announceMoving(true);

    if (s.mode === "search") {
      const { spot } = await this.resolveSpot(s.region, s.trail);
      if (!spot) {
        this.gameState.moving = false;
        this.notice("場所が見つからずラウンドを終了します");
        await this.settleClassicRound(true);
        return;
      }
      this.notice("⌛ 時間切れ。逃走者の隠れ場所を自動で決めました");
      await this.goSearchLive(spot);
      return;
    }

    if (s.mode === "duel") {
      if (!s.duel) s.duel = {};
      const ids = s.duelPlayers ?? [...this.onlineIds()].slice(0, 2);
      const placedSpots = Object.values(s.duel).map((d) => d.spot.point);
      for (const id of ids) {
        if (s.duel[id]) continue;
        const { spot } = await this.resolveSpot(s.region, placedSpots);
        if (spot) {
          s.duel[id] = { spot };
          placedSpots.push(spot.point);
        }
      }
      this.gameState.moving = false;
      if (Object.keys(s.duel).length >= 2) {
        this.notice("⌛ 時間切れ。未選択の隠れ場所は自動で決めました");
        await this.goDuelLive();
      } else {
        this.notice("プレイヤーが足りないため対決を終了します");
        await this.stopGame();
      }
    }
  }

  /** search: 逃走者が選んだ場所で捜索を開始する */
  private async goSearchLive(spot: StreetSpot) {
    const now = Date.now();
    this.gameState.runnerPosition = spot.point;
    this.gameState.trail = [...this.gameState.trail, spot.point].slice(-TRAIL_LENGTH);
    this.applySpot(spot, spot.point);
    this.gameState.phase = "live";
    this.gameState.moving = false;
    this.gameState.lastMoveAt = now;
    this.gameState.nextUpdateAt = now + this.gameState.intervalMs;
    this.gameState.roundEndsAt =
      this.gameState.timeLimitSeconds > 0 ? now + this.gameState.timeLimitSeconds * 1000 : 0;

    await this.ctx.storage.deleteAlarm();
    if (this.gameState.roundEndsAt > 0) await this.ctx.storage.setAlarm(this.gameState.roundEndsAt);

    this.notice("👣 逃走者が潜伏した！ ストリートビューを手がかりに現在地を当てよう");
    await this.persist();
    this.broadcast(this.publicState());
    this.pushRunnerPosition();
  }

  /** duel: 両者の場所が揃ったら、相手の地点をそれぞれの「問題」として配って開始する */
  private async goDuelLive() {
    const s = this.gameState;
    if (!s.duel) return;
    const ids = Object.keys(s.duel);
    if (ids.length < 2) return;

    const now = Date.now();
    s.phase = "live";
    s.moving = false;
    s.lastMoveAt = now;
    s.roundEndsAt = s.timeLimitSeconds > 0 ? now + s.timeLimitSeconds * 1000 : 0;

    await this.ctx.storage.deleteAlarm();
    if (s.roundEndsAt > 0) await this.ctx.storage.setAlarm(s.roundEndsAt);

    this.notice("⚔ 対決開始！ 何度でも回答できる。先に0.5km以内を当てた方の勝ち！");
    await this.persist();
    this.broadcast(this.publicState());
    // 状態(phase=live)を配ってから各自の「相手の地点」を届ける
    this.sendDuelPuzzles();
  }

  /** duel: 各プレイヤーに「相手の地点」の映像を配る */
  private sendDuelPuzzles(only?: WebSocket) {
    const s = this.gameState;
    if (s.mode !== "duel" || s.phase !== "live" || !s.duel) return;
    const ids = Object.keys(s.duel);
    if (ids.length < 2) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (only && ws !== only) continue;
      const pid = this.attachmentOf(ws)?.playerId;
      if (!pid || !ids.includes(pid)) continue;
      const oppId = ids.find((x) => x !== pid)!;
      const spot = s.duel[oppId].spot;
      try {
        ws.send(
          JSON.stringify({
            type: "duel_puzzle",
            imageId: spot.imageId,
            imageUrl: spot.imageUrl,
            isPano: spot.isPano,
            compassAngle: spot.compassAngle ?? null,
          })
        );
      } catch {}
    }
  }

  /** search/duel: 地図で選んだ場所を、その付近の車載360°地点に確定する */
  private async handlePlace(ws: WebSocket, userId: string, lat: number, lng: number) {
    const s = this.gameState;
    if (s.status !== "running" || s.phase !== "setup" || s.moving) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

    if (s.mode === "search") {
      if (userId !== s.runnerId) {
        this.tell(ws, "隠れ場所を選べるのは逃走者だけです");
        return;
      }
    } else if (s.mode === "duel") {
      if (!s.duelPlayers?.includes(userId)) {
        this.tell(ws, "この対決の参加者ではありません（観戦中）");
        return;
      }
      if (!s.duel) s.duel = {};
      if (s.duel[userId]) {
        this.tell(ws, "隠れ場所はもう決まっています。相手を待ちましょう");
        return;
      }
    } else {
      return;
    }

    // 対決では片方の確定処理中に全員へ「移動中」を出さない(確定者本人にはボタン側で示す)
    const quiet = s.mode === "duel";
    if (!quiet) this.announceMoving(true);
    const spot = await nearestImage(this.env.MAPILLARY_TOKEN, { lat, lng }, { panoOnly: false, carOnly: true });

    if (!spot) {
      this.gameState.moving = false;
      this.tell(ws, "その付近に車載の撮影がありません。地図の「🟢 360°の道」「⚪ 平面のみの道」で線を表示し、その近くを選んでください");
      if (!quiet) this.broadcast(this.publicState());
      return;
    }

    if (s.mode === "search") {
      try {
        ws.send(JSON.stringify({ type: "placed" }));
      } catch {}
      await this.goSearchLive(spot);
      return;
    }

    // duel
    s.duel![userId] = { spot };
    s.moving = false;
    try {
      ws.send(JSON.stringify({ type: "placed" }));
    } catch {}
    const placed = Object.keys(s.duel!).length;
    this.notice(`🫥 ${this.playerLabel(userId)} が隠れ場所を決めた（${placed}/2）`);
    await this.persist();
    this.broadcast(this.publicState());
    if (placed >= 2) await this.goDuelLive();
  }

  /** 逃走者本人にだけ、いまの自分の位置を届ける(地図に「あなた」マーカーを出すため) */
  private pushRunnerPosition() {
    const s = this.gameState;
    if (s.mode !== "search" || s.status !== "running" || s.phase !== "live" || !s.runnerId || !s.runnerPosition) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachmentOf(ws)?.playerId !== s.runnerId) continue;
      try {
        ws.send(JSON.stringify({ type: "runner_pos", position: s.runnerPosition }));
      } catch {}
    }
  }

  /**
   * Search & Chase: 逃走者の移動。
   * 逃走者は映像内を自由に下見でき、間隔が経過したら
   * 「いま見ている場所」へ実際に移動できる(車載360°のみ・1回2.5kmまで)。
   */
  private async handleRelocate(ws: WebSocket, userId: string, lat: number, lng: number, imageId: string) {
    const s = this.gameState;
    if (s.mode !== "search" || s.status !== "running" || s.phase !== "live" || s.moving) return;
    if (!userId || userId !== s.runnerId) return;
    if (typeof imageId !== "string" || !imageId) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!s.runnerPosition) return;

    const now = Date.now();
    if (now < s.nextUpdateAt - 750) {
      const wait = Math.ceil((s.nextUpdateAt - now) / 1000);
      this.tell(ws, `まだ移動できません（あと${wait}秒）。映像で下見して待ちましょう`);
      return;
    }

    const hopKm = haversineKm(s.runnerPosition, { lat, lng });
    if (hopKm > MOVE_CAP_KM) {
      this.tell(ws, `一度に移動できるのは${MOVE_CAP_KM}kmまでです（今は${hopKm.toFixed(1)}km先）`);
      return;
    }

    this.announceMoving(true);
    const spot = await fetchSpotForImage(this.env.MAPILLARY_TOKEN, imageId);

    if (!spot) {
      this.gameState.moving = false;
      this.tell(ws, "その地点へは移動できません（車載の360°地点だけが隠れ場所になれます）");
      this.broadcast(this.publicState());
      return;
    }

    this.gameState.runnerPosition = spot.point;
    this.gameState.trail = [...this.gameState.trail, spot.point].slice(-TRAIL_LENGTH);
    this.applySpot(spot, spot.point);
    this.gameState.moving = false;
    this.gameState.lastMoveAt = now;
    this.gameState.nextUpdateAt = now + this.gameState.intervalMs;

    this.notice("👣 逃走者が移動した！");
    await this.persist();
    this.broadcast(this.publicState());
    this.pushRunnerPosition();
  }

  /**
   * Search & Chase: 行き止まり脱出の地図ジャンプ。
   * 映像内移動と同じ間隔・同じ距離上限を守りつつ、地図で指した近くの道へ跳ぶ。
   * 強力なぶん回数制(1ラウンド2回)。
   */
  private async handleJump(ws: WebSocket, userId: string, lat: number, lng: number) {
    const s = this.gameState;
    if (s.mode !== "search" || s.status !== "running" || s.phase !== "live" || s.moving) return;
    if (!userId || userId !== s.runnerId) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!s.runnerPosition) return;

    if (s.searchJumpsLeft <= 0) {
      this.tell(ws, "地図ジャンプは使い切りました（映像内の移動は引き続き可能）");
      return;
    }
    const now = Date.now();
    if (now < s.nextUpdateAt - 750) {
      const wait = Math.ceil((s.nextUpdateAt - now) / 1000);
      this.tell(ws, `まだ移動できません（あと${wait}秒）`);
      return;
    }
    const hopKm = haversineKm(s.runnerPosition, { lat, lng });
    if (hopKm > MOVE_CAP_KM) {
      this.tell(ws, `一度に移動できるのは${MOVE_CAP_KM}kmまでです（今は${hopKm.toFixed(1)}km先）`);
      return;
    }

    this.announceMoving(true);
    const spot = await nearestImage(this.env.MAPILLARY_TOKEN, { lat, lng }, { panoOnly: false, carOnly: true });

    if (!spot) {
      this.gameState.moving = false;
      this.tell(ws, "その付近に車載の撮影がありません。少しずらして指定してください");
      this.broadcast(this.publicState());
      return;
    }

    this.gameState.runnerPosition = spot.point;
    this.gameState.trail = [...this.gameState.trail, spot.point].slice(-TRAIL_LENGTH);
    this.applySpot(spot, spot.point);
    this.gameState.searchJumpsLeft -= 1;
    this.gameState.moving = false;
    this.gameState.lastMoveAt = now;
    this.gameState.nextUpdateAt = now + this.gameState.intervalMs;

    this.notice(`👣 逃走者が別の道へ跳んだ！（地図ジャンプ 残り${this.gameState.searchJumpsLeft}回）`);
    await this.persist();
    this.broadcast(this.publicState());
    this.pushRunnerPosition();
  }

  async revealNextHint() {
    if (this.gameState.status !== "running") return;
    if (this.gameState.revealedHintCount >= this.gameState.allHints.length) return;

    this.gameState.revealedHintCount += 1;
    this.gameState.hintPenalty += HINT_PENALTY;
    await this.persist();
    this.broadcast(this.publicState());
  }

  async startClassicGame(
    mode: "classic" | "search" | "duel",
    region: RegionKey,
    timeLimitSeconds: number,
    rounds: number,
    preferredRunnerId?: string
  ) {
    await this.ctx.storage.deleteAlarm();
    this.gameState = {
      ...DEFAULT_STATE,
      mode,
      runnerId: mode === "search" ? preferredRunnerId ?? null : null,
      duelPlayers: mode === "duel" ? [...this.onlineIds()].slice(0, 2) : null,
      region,
      regionUsed: region,
      timeLimitSeconds,
      maxRounds: rounds,
      round: 0,
      startedAt: Date.now(),
      scoreboard: {},
    };
    await this.beginClassicRound();
  }

  async startNextClassicRound() {
    if (this.gameState.mode === "chase" || this.gameState.status !== "reveal") return;
    await this.beginClassicRound();
  }

  private async beginClassicRound() {
    this.announceMoving(true);

    // Search & Chase: 逃走者を確定する。
    // ホストの指名があればそれを使い、不在(未指名/切断)なら接続中からランダムに選ぶ
    if (this.gameState.mode === "search") {
      const online = [...this.onlineIds()];
      const changed = !this.gameState.runnerId || !online.includes(this.gameState.runnerId);
      if (changed) {
        this.gameState.runnerId = online[Math.floor(Math.random() * online.length)] ?? null;
      }
      if (this.gameState.runnerId && (changed || this.gameState.round === 0)) {
        this.notice(`👣 ${this.playerLabel(this.gameState.runnerId)} が逃走者！ 追手はこのプレイヤーの現在地を当てよう`);
      }
    }

    const needsSetup = this.gameState.mode === "search" || this.gameState.mode === "duel";

    // search/duel はプレイヤーが場所を選ぶまで地点を作らない
    const { spot, region: used } = needsSetup
      ? { spot: null as StreetSpot | null, region: this.gameState.region }
      : await this.resolveSpot(this.gameState.region, this.gameState.trail);
    const position = spot?.point ?? this.gameState.runnerPosition ?? randomFallbackPoint(this.gameState.region);
    // 逃走者/相手が場所を選ぶモードでは地名ヒントは成立しない
    const hints = needsSetup ? [] : await buildPlaceHints(position, this.env.SESSIONS, regionHintLevel(used));
    const now = Date.now();

    this.resetRoundScores();

    this.gameState = {
      ...this.gameState,
      status: "running",
      round: this.gameState.round + 1,
      regionUsed: used,
      trail: [...this.gameState.trail, position].slice(-TRAIL_LENGTH),
      allHints: hints,
      revealedHintCount: 0,
      hintPenalty: 0,
      attempts: 0,
      roundGuesses: [],
      classicAnswers: {},
      nextUpdateAt: 0,
      roundEndsAt: !needsSetup && this.gameState.timeLimitSeconds > 0 ? now + this.gameState.timeLimitSeconds * 1000 : 0,
      relocationsLeft: 0,
      searchJumpsLeft: this.gameState.mode === "search" ? SEARCH_JUMPS_PER_ROUND : 0,
      phase: needsSetup ? "setup" : null,
      duel: this.gameState.mode === "duel" ? {} : null,
      moving: false,
      lastMoveAt: now,
    };
    this.applySpot(spot, position);
    if (needsSetup) {
      // 場所選び中は「画像なし」扱いにしない(専用の案内を出す)
      this.gameState.imageMissing = false;
      this.gameState.runnerPosition = null;
    }
    if (this.gameState.mode === "duel") {
      this.notice("⚔ 対決モード！ まずお互いに地図で「隠れ場所」を選ぼう（相手には見えません）");
    }

    if (this.gameState.imageMissing) {
      this.notice("この地点の写真が見つかりませんでした。ヒントと地図で推理してください");
    }

    await this.persist();
    this.broadcast(this.publicState());
    this.pushRunnerPosition();

    if (needsSetup) {
      // 場所選びが放置されてもゲームが止まらないように猶予アラーム
      await this.ctx.storage.setAlarm(now + SETUP_TIMEOUT_MS);
    } else if (this.gameState.timeLimitSeconds > 0) {
      await this.ctx.storage.setAlarm(this.gameState.roundEndsAt);
    }
  }

  async startChaseGame(region: RegionKey, intervalMs: number) {
    await this.ctx.storage.deleteAlarm();

    this.gameState = {
      ...DEFAULT_STATE,
      mode: "chase",
      region,
      regionUsed: region,
      intervalMs,
      startedAt: Date.now(),
      scoreboard: {},
    };
    this.announceMoving(true);

    const { spot, region: used } = await this.resolveSpot(region, []);
    const position = spot?.point ?? randomFallbackPoint(region);
    const hints = await buildPlaceHints(position, this.env.SESSIONS, regionHintLevel(used));
    const now = Date.now();

    this.gameState = {
      ...DEFAULT_STATE,
      mode: "chase",
      status: "running",
      round: 1,
      maxRounds: CHASE_ROUNDS,
      trail: [position],
      allHints: hints,
      nextUpdateAt: now + intervalMs,
      intervalMs,
      region,
      regionUsed: used,
      startedAt: now,
      moving: false,
      lastMoveAt: now,
      scoreboard: {},
    };
    this.applySpot(spot, position);

    if (this.gameState.imageMissing) {
      this.notice("この地点の写真が見つかりませんでした。ヒントと地図で推理してください");
    }

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

    if (this.gameState.phase === "setup") {
      await this.resolveSetupTimeout();
      return;
    }

    if (this.gameState.mode === "duel") {
      await this.settleDuel(true, null);
      return;
    }

    if (this.gameState.mode !== "chase") {
      await this.settleClassicRound(true);
      return;
    }

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

    // 探索は十数秒かかることがある。先に「移動中」を配信して無反応にしない
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

    const fallback = moved ? null : await this.resolveSpot(this.gameState.region, this.gameState.trail);
    const spot = moved?.spot ?? fallback?.spot ?? null;
    const used = moved?.region ?? fallback?.region ?? this.gameState.regionUsed;
    const position = spot?.point ?? previous;

    const hints = await buildPlaceHints(position, this.env.SESSIONS, regionHintLevel(used));

    this.resetRoundScores();

    this.gameState.round += 1;
    this.gameState.regionUsed = used;
    this.gameState.lastBearing = moved?.bearing ?? this.gameState.lastBearing;
    this.gameState.trail = [...this.gameState.trail, position].slice(-TRAIL_LENGTH);
    this.applySpot(spot, position);
    this.gameState.allHints = hints;
    this.gameState.revealedHintCount = 0;
    this.gameState.hintPenalty = 0;
    this.gameState.attempts = 0;
    this.gameState.roundGuesses = [];
    this.gameState.classicAnswers = {};
    this.gameState.moving = false;
    this.gameState.lastMoveAt = Date.now();
    this.gameState.nextUpdateAt = this.gameState.lastMoveAt + this.gameState.intervalMs;

    if (this.gameState.imageMissing) {
      this.notice("移動先の写真が見つかりませんでした。ヒントと地図で推理してください");
    }

    await this.persist();
    this.broadcast(this.publicState());
    await this.ctx.storage.setAlarm(this.gameState.nextUpdateAt);
  }

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
        this.gameState.regionUsed,
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

  broadcast(msg: unknown, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch {
        try {
          ws.close(1011, "send failed");
        } catch {}
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
      compassAngle: s.compassAngle,
      imageMissing: s.imageMissing,
      region: s.region,
      regionUsed: s.regionUsed,
      revealedHints: s.allHints.slice(0, s.revealedHintCount),
      hintsAvailable: Math.max(0, s.allHints.length - s.revealedHintCount),
      hintPenalty: s.hintPenalty,
      attempts: s.attempts,
      totalScore: this.roomTopScore(),
      intervalSeconds: Math.round(s.intervalMs / 1000),
      timeLimitSeconds: s.timeLimitSeconds,
      nextUpdateAt:
        (s.mode === "chase" || (s.mode === "search" && s.phase === "live")) &&
        s.status === "running" &&
        !s.moving
          ? s.nextUpdateAt
          : 0,
      roundEndsAt: s.mode !== "chase" && s.status === "running" && !s.moving ? s.roundEndsAt : 0,
      serverNow: Date.now(),
      players: this.playerCount(exclude),
      hostId: this.hostId(exclude),
      answered: Object.keys(s.classicAnswers).length,
      scoreboard: this.scoreboardList(exclude),
      phase: s.phase ?? null,
      placedCount: s.duel ? Object.keys(s.duel).length : 0,
      roster: this.rosterList(),
      runnerId: s.mode === "search" ? s.runnerId : null,
      runnerName: s.mode === "search" && s.runnerId ? this.playerLabel(s.runnerId) : null,
      relocationsLeft: s.mode === "search" ? s.relocationsLeft : 0,
      searchJumpsLeft: s.mode === "search" ? s.searchJumpsLeft : 0,
      moving: s.moving,
      lastMoveAt: s.lastMoveAt,
      revealedTrail: s.revealedTrail,
      history: s.history,
    };
  }
}

function roundTo(value: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

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