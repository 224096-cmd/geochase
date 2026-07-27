export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  SESSIONS: KVNamespace;
  MAPILLARY_TOKEN: string;
  ALLOWED_ORIGIN: string;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export type RegionKey =
  | "hokkaido"
  | "tohoku"
  | "kanto"
  | "chubu"
  | "kinki"
  | "chugoku"
  | "shikoku"
  | "kyushu_okinawa"
  | "japan_wide"
  | "world";

export type GameMode = "classic" | "chase";
/** reveal = 回答済みで答え合わせ表示中（通常モードのみ） */
export type GameStatus = "idle" | "running" | "reveal" | "finished";

export interface StartRequestBody {
  mode?: GameMode;
  region?: RegionKey;
  intervalSeconds?: number; // AI逃走モードの移動間隔(秒)
  timeLimitSeconds?: number; // 通常モードの1ラウンド制限時間(秒)。最大1800(30分)
  rounds?: number; // 通常モードのラウンド数(1〜10)
  playerName?: string;
}

/** Mapillaryから取得した1地点ぶんの情報 */
export interface StreetSpot {
  point: LatLng;
  imageUrl: string;
  imageId: string;
  isPano: boolean;
}

/** ラウンド終了後にクライアントへ公開する結果 */
export interface RoundRecord {
  round: number;
  target: LatLng;
  guess: LatLng | null;
  distanceKm: number | null;
  score: number;
  caught: boolean;
}

/** サーバーがクライアントへ送る状態。正解座標(aiPosition)はラウンド終了まで含めない */
export interface PublicState {
  type?: "state";
  mode: GameMode;
  status: GameStatus;
  round: number;
  maxRounds: number;
  imageId: string;
  imageUrl: string;
  isPano: boolean;
  region: RegionKey;
  revealedHints: string[];
  hintsAvailable: number;
  hintPenalty: number;
  attempts: number;
  totalScore: number;
  intervalSeconds: number;
  timeLimitSeconds: number;
  /** 絶対時刻(epoch ms)。クライアントはこれと serverNow の差でカウントダウンする */
  nextUpdateAt: number;
  roundEndsAt: number;
  serverNow: number;
  players: number;
  /** 決着済みラウンドのAI位置のみ。進行中ラウンドの答えは含まない */
  revealedTrail: LatLng[];
  history: RoundRecord[];
}

export type ClientMessage =
  | { type: "guess"; lat: number; lng: number; userId?: string; playerName?: string }
  | { type: "hint" }
  | { type: "next" }
  | { type: "sync" };

export interface GuessResultMessage {
  type: "result";
  distanceKm: number | null;
  correct: boolean;
  score: number;
  /** 近さの手応え。逃走モードで外したときのフィードバック */
  proximity: "burning" | "hot" | "warm" | "cold" | "freezing" | null;
  bearing: number | null;
  target?: LatLng;
  timeUp?: boolean;
  roundOver: boolean;
}