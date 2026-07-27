export type Mode = "classic" | "chase";
export type GameStatus = "idle" | "running" | "reveal" | "finished";
export type Proximity = "burning" | "hot" | "warm" | "cold" | "freezing";

export interface LatLng {
  lat: number;
  lng: number;
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
  revealedTrail: LatLng[];
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