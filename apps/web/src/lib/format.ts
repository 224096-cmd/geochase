import type { Proximity } from "./types";

/** 距離を人が読みやすい単位で返す。1km未満はm表記 */
export function formatDistance(km: number | null): string {
  if (km === null || !Number.isFinite(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString("ja-JP")} km`;
}

/** 秒数を m:ss 形式に。カウントダウン表示は桁が動かないよう常に2桁 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function formatScore(score: number): string {
  return score.toLocaleString("ja-JP");
}

const COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];

/** 方位角(度)を八方位の日本語に変換 */
export function formatBearing(deg: number | null): string | null {
  if (deg === null || !Number.isFinite(deg)) return null;
  const index = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return COMPASS[index];
}

export const PROXIMITY_LABEL: Record<Proximity, string> = {
  burning: "目の前",
  hot: "かなり近い",
  warm: "近い",
  cold: "遠い",
  freezing: "かなり遠い",
};

/** 逃走モードのミス時に返すひとこと */
export function proximityMessage(proximity: Proximity | null, bearing: number | null): string {
  if (!proximity) return "";
  const direction = formatBearing(bearing);
  const base = PROXIMITY_LABEL[proximity];
  return direction ? `${base}。ここから${direction}の方角にいる` : base;
}