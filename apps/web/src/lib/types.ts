export type Mode = "classic" | "chase";
export type GameStatus = "idle" | "running" | "reveal" | "finished";
export type Proximity = "burning" | "hot" | "warm" | "cold" | "freezing";

export interface LatLng {
  lat: number;
  lng: number;
}

/** 公開済みの軌跡。round があればツールチップに正しいラウンド番号を出せる */
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

export interface RoomState {
  type: "state";
  mode: Mode;
  status: GameStatus;
  round: number;
  maxRounds: number;
  imageId: string;
  imageUrl: string;
  isPano: boolean;
  region: string;
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
  /** いちばん先に入室した人のID。設定変更と開始・停止はこの人だけができる */
  hostId?: string | null;
  /** 通常モードで、このラウンドに回答済みの人数 */
  answered?: number;
  /** サーバーが次の地点を探している最中 */
  moving?: boolean;
  /** 直近の移動完了時刻。変化を検知して通知を出す */
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
  /** 通常モードで自分の回答は受理されたが、他の人を待っている状態 */
  waiting?: boolean;
}

export interface CaughtMessage {
  type: "caught";
  userId: string;
  playerName: string | null;
  round: number;
  score: number;
}

export type ServerMessage = RoomState | GuessResult | CaughtMessage;

export interface StartOptions {
  mode: Mode;
  region: string;
  intervalSeconds: number;
  timeLimitSeconds: number;
  rounds: number;
}