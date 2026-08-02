export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  SESSIONS: KVNamespace;
  MAPILLARY_TOKEN: string;
  ALLOWED_ORIGIN: string;
  /** 同梱の線路タイル(電車判定用)。assetsバインディング */
  RAIL: Fetcher;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TrailPoint extends LatLng {
  round: number;
}

export type RegionKey = string;

export type GameMode = "classic" | "chase" | "search" | "duel";
export type GameStatus = "idle" | "running" | "reveal" | "finished";

export type TransportMode = "car" | "foot" | "cycle" | "rail_or_boat" | "air" | "unknown";

export interface StartRequestBody {
  mode?: GameMode;
  region?: RegionKey;
  intervalSeconds?: number;
  timeLimitSeconds?: number;
  rounds?: number;
  playerId?: string;
}

export interface StreetSpot {
  point: LatLng;
  imageUrl: string;
  imageId: string;
  isPano: boolean;
  sequenceId?: string;
  neighbors?: number;
  width?: number;
  capturedAt?: number;
  cameraType?: string;
  compassAngle?: number;
  qualityScore?: number;
  transport?: TransportMode;
}

export interface RoundRecord {
  round: number;
  target: LatLng;
  guess: LatLng | null;
  distanceKm: number | null;
  score: number;
  caught: boolean;
}

export interface PlayerScore {
  id: string;
  name: string | null;
  total: number;
  lastRound: number;
  answered: number;
  bestKm: number | null;
  online: boolean;
}

export interface PublicState {
  type?: "state";
  mode: GameMode;
  status: GameStatus;
  round: number;
  maxRounds: number;
  imageId: string;
  imageUrl: string;
  isPano: boolean;
  compassAngle: number | null;
  imageMissing: boolean;
  region: RegionKey;
  regionUsed: RegionKey;
  revealedHints: string[];
  hintsAvailable: number;
  hintPenalty: number;
  attempts: number;
  totalScore: number;
  intervalSeconds: number;
  timeLimitSeconds: number;
  nextUpdateAt: number;
  roundEndsAt: number;
  serverNow: number;
  players: number;
  hostId: string | null;
  answered: number;
  scoreboard: PlayerScore[];
  /** search/duel の進行段階。setup=場所選び中 */
  phase: "setup" | "live" | null;
  /** duel: 場所を決め終えた人数 */
  placedCount: number;
  /** 接続中のプレイヤー一覧(逃走者の指名UI用) */
  roster: { id: string; name: string | null }[];
  /** Search & Chase: 逃走役のプレイヤーID(他モードではnull) */
  runnerId: string | null;
  runnerName: string | null;
  /** Search & Chase: 逃走者の残り移動回数 */
  relocationsLeft: number;
  /** Search & Chase: 行き止まり脱出用の地図ジャンプ残り回数 */
  searchJumpsLeft: number;
  moving: boolean;
  lastMoveAt: number;
  revealedTrail: TrailPoint[];
  history: RoundRecord[];
}

export type ClientMessage =
  | { type: "guess"; lat: number; lng: number; userId?: string; playerName?: string }
  | { type: "hint" }
  | { type: "next" }
  | { type: "place"; lat: number; lng: number; userId?: string }
  | { type: "relocate"; lat: number; lng: number; imageId: string; userId?: string }
  | { type: "jump"; lat: number; lng: number; userId?: string }
  | { type: "rename"; playerName: string }
  | { type: "sync" };

export interface GuessResultMessage {
  type: "result";
  distanceKm: number | null;
  correct: boolean;
  score: number;
  proximity: "burning" | "hot" | "warm" | "cold" | "freezing" | null;
  bearing: number | null;
  target?: LatLng;
  timeUp?: boolean;
  roundOver: boolean;
  waiting?: boolean;
}

export interface NoticeMessage {
  type: "notice";
  message: string;
}