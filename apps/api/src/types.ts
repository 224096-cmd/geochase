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

/** 公開済みの軌跡。どのラウンドの位置かが分かるようにroundを持たせる */
export interface TrailPoint extends LatLng {
  round: number;
}

/** REGION_DEFS のキー。都道府県・国を増やしても型を直さなくて済むよう文字列にしている */
export type RegionKey = string;

export type GameMode = "classic" | "chase";
/** reveal = 回答済みで答え合わせ表示中（通常モードのみ） */
export type GameStatus = "idle" | "running" | "reveal" | "finished";

export interface StartRequestBody {
  mode?: GameMode;
  region?: RegionKey;
  intervalSeconds?: number; // 逃走モードの移動間隔(秒)
  timeLimitSeconds?: number; // 通常モードの1ラウンド制限時間(秒)。最大1800(30分)
  rounds?: number; // 通常モードのラウンド数(1〜10)
  /** ホストだけが開始・停止できるようにするための識別子 */
  playerId?: string;
}

/** Mapillaryから取得した1地点ぶんの情報 */
export interface StreetSpot {
  point: LatLng;
  imageUrl: string;
  imageId: string;
  isPano: boolean;
  /** 同じ撮影シーケンスのID。前後に歩けるかの目安 */
  sequenceId?: string;
  /** 半径150m以内にある画像の枚数。少ないと「ほとんど動けない地点」 */
  neighbors?: number;
  /** 元画像の横ピクセル数。看板が読めるかを左右する */
  width?: number;
  /** 撮影日時(epoch ms)。新しいほどカメラが良く、画質も高い傾向 */
  capturedAt?: number;
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

/** サーバーがクライアントへ送る状態。正解座標(runnerPosition)はラウンド終了まで含めない */
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
  /** いちばん先に入室した人のID。設定変更と開始・停止はこの人だけができる */
  hostId: string | null;
  /** 通常モードで、このラウンドに回答済みのプレイヤー数 */
  answered: number;
  /** 次の地点をMapillaryから探している最中 */
  moving: boolean;
  /** 直近で逃走者が移動した時刻(epoch ms) */
  lastMoveAt: number;
  /** 決着済みラウンドの逃走者位置のみ。進行中ラウンドの答えは含まない */
  revealedTrail: TrailPoint[];
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
  /** 通常モードで自分の回答は受理されたが、他の人を待っている状態 */
  waiting?: boolean;
}