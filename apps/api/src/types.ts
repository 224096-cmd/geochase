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

export interface ChaseUpdateMessage {
  type: "update";
  round: number;
  imageUrl: string;
  hint: string;
  secondsUntilNext: number;
}

export interface GuessMessage {
  type: "guess";
  lat: number;
  lng: number;
}

export interface GuessResultMessage {
  type: "result";
  distanceKm: number;
  correct: boolean;
  score: number;
}

export interface StateMessage {
  type: "state";
  round: number;
  imageUrl: string;
  hint: string;
  secondsUntilNext: number;
  status: "running" | "finished";
}
