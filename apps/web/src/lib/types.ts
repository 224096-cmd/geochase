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

/** プレイヤー1人ぶんの成績。距離からの点は回答者ごとに独立して計算される */
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
  /** 設定変更・開始・停止・次のラウンドができる人のID */
  hostId?: string | null;
  /** 通常モードで、このラウンドに回答済みの人数 */
  answered?: number;
  /** 累計スコア順のプレイヤー一覧 */
  scoreboard?: PlayerScore[];
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

/** ホスト以外が操作したときなど、自分にだけ届く短いお知らせ */
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
}