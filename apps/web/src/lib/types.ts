export type Mode = "classic" | "chase" | "search" | "duel";
export type GameStatus = "idle" | "running" | "reveal" | "finished";
export type Proximity = "burning" | "hot" | "warm" | "cold" | "freezing";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TrailPoint extends LatLng {
  round?: number;
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

export interface RoomState {
  type: "state";
  mode: Mode;
  status: GameStatus;
  round: number;
  maxRounds: number;
  imageId: string;
  imageUrl: string;
  isPano: boolean;
  compassAngle?: number | null;
  imageMissing?: boolean;
  region: string;
  regionUsed?: string;
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
  hostId?: string | null;
  answered?: number;
  scoreboard?: PlayerScore[];
  /** search/duel の進行段階。setup=場所選び中 */
  phase?: "setup" | "live" | null;
  /** duel: 場所を決め終えた人数 */
  placedCount?: number;
  /** 接続中のプレイヤー一覧(逃走者の指名UI用) */
  roster?: { id: string; name: string | null }[];
  /** Search & Chase: 逃走役プレイヤー(他モードではnull) */
  runnerId?: string | null;
  runnerName?: string | null;
  relocationsLeft?: number;
  moving?: boolean;
  lastMoveAt?: number;
  revealedTrail: TrailPoint[];
  history: RoundRecord[];
}

export interface GuessResult {
  type: "result";
  distanceKm: number | null;
  correct: boolean;
  score: number;
  proximity: Proximity | null;
  bearing: number | null;
  target?: LatLng;
  timeUp?: boolean;
  roundOver: boolean;
  waiting?: boolean;
}

export interface CaughtMessage {
  type: "caught";
  userId: string;
  playerName: string | null;
  round: number;
  score: number;
}

export interface NoticeMessage {
  type: "notice";
  message: string;
}

export type ServerMessage = RoomState | GuessResult | CaughtMessage | NoticeMessage;

export interface StartOptions {
  mode: Mode;
  region: string;
  intervalSeconds: number;
  timeLimitSeconds: number;
  rounds: number;
  /** Search & Chase: 逃走者の指名(省略でランダム) */
  runnerId?: string;
}

export type StageMode = "split" | "street" | "map";