import type { LatLng } from "./types";

const MAPILLARY_GRAPH_URL = "https://graph.mapillary.com/images";
const OSRM_URL = "https://router.project-osrm.org"; // 無料の公開デモサーバー（個人利用OK。商用不可）

/**
 * 指定した中心座標の周辺(bboxDegrees度四方)から、Mapillaryに登録されている
 * 撮影地点をランダムに1つ取得する。
 * Mapillaryの画像は道路や歩道に沿って撮影されているため、
 * 「道路上のランダムな地点」として扱える。
 */
export async function fetchRandomStreetPoint(
  token: string,
  center: LatLng,
  bboxDegrees = 0.02
): Promise<{ point: LatLng; imageUrl: string; imageId: string } | null> {
  const bbox = [
    center.lng - bboxDegrees,
    center.lat - bboxDegrees,
    center.lng + bboxDegrees,
    center.lat + bboxDegrees,
  ].join(",");

  const url = `${MAPILLARY_GRAPH_URL}?access_token=${token}&fields=id,geometry,thumb_2048_url&bbox=${bbox}&limit=50`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    data: { id: string; geometry: { coordinates: [number, number] }; thumb_2048_url: string }[];
  };
  if (!data.data || data.data.length === 0) return null;

  const pick = data.data[Math.floor(Math.random() * data.data.length)];
  const [lng, lat] = pick.geometry.coordinates;
  return { point: { lat, lng }, imageUrl: pick.thumb_2048_url, imageId: pick.id };
}

/**
 * OSRMのルーティングAPIを使って、現在地から道路沿いにある程度の距離だけ
 * 離れた「次の移動候補地点」を計算する。
 * AI逃走モードの1ステップ移動先を決めるために使う。
 */
export async function nextRoadPoint(
  from: LatLng,
  bearingDeg: number,
  distanceKm = 0.8
): Promise<LatLng> {
  // 現在地からbearing方向へざっくり移動した仮の目的地を作り、
  // OSRMのroute APIで実際の道路にスナップした経路を取得する
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = rad(from.lat);
  const lng1 = rad(from.lng);
  const brng = rad(bearingDeg);
  const dr = distanceKm / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );

  const roughTarget = { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };

  const routeUrl = `${OSRM_URL}/route/v1/driving/${from.lng},${from.lat};${roughTarget.lng},${roughTarget.lat}?overview=false`;
  try {
    const res = await fetch(routeUrl);
    if (!res.ok) return roughTarget; // OSRMが失敗したら仮目的地をそのまま使う
    const data = (await res.json()) as {
      routes: { legs: { steps: { maneuver: { location: [number, number] } }[] }[] }[];
    };
    const steps = data.routes?.[0]?.legs?.[0]?.steps;
    if (!steps || steps.length === 0) return roughTarget;
    const lastStep = steps[steps.length - 1];
    const [lng, lat] = lastStep.maneuver.location;
    return { lat, lng };
  } catch {
    return roughTarget;
  }
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
