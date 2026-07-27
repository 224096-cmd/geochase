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

export interface StartRequestBody {
  mode?: GameMode;
  region?: RegionKey;
  intervalSeconds?: number; // AI逃走モードの移動間隔(秒)
  timeLimitSeconds?: number; // 通常モードの制限時間(秒)。最大1800(30分)
}