import type { LatLng, RegionKey } from "./types";

const MAPILLARY_GRAPH_URL = "https://graph.mapillary.com/images";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";

// [minLng, minLat, maxLng, maxLat]
type Bbox = [number, number, number, number];

export const REGION_DEFS: Record<RegionKey, { label: string; bboxes: Bbox[] }> = {
  hokkaido: { label: "北海道", bboxes: [[139.3, 41.0, 145.8, 45.6]] },
  tohoku: { label: "東北", bboxes: [[139.3, 36.8, 141.9, 41.6]] },
  kanto: { label: "関東", bboxes: [[138.3, 34.8, 140.9, 37.2]] },
  chubu: { label: "中部", bboxes: [[135.9, 34.6, 139.9, 38.0]] },
  kinki: { label: "近畿", bboxes: [[134.7, 33.4, 136.5, 35.8]] },
  chugoku: { label: "中国", bboxes: [[130.8, 33.7, 134.5, 35.8]] },
  shikoku: { label: "四国", bboxes: [[132.0, 32.7, 134.8, 34.6]] },
  kyushu_okinawa: { label: "九州・沖縄", bboxes: [[122.9, 24.0, 131.3, 34.0]] },
  japan_wide: { label: "日本全国", bboxes: [[122.9, 24.0, 145.8, 45.6]] },
  world: {
    label: "世界",
    bboxes: [
      [139.4, 35.4, 140.0, 35.9],
      [-74.3, 40.6, -73.7, 40.9],
      [-0.4, 51.3, 0.2, 51.7],
      [2.1, 48.7, 2.5, 48.98],
      [150.9, -34.0, 151.4, -33.7],
      [126.8, 37.4, 127.2, 37.7],
      [13.2, 52.4, 13.6, 52.6],
      [4.7, 52.25, 5.0, 52.45],
      [100.4, 13.6, 100.7, 13.9],
      [-99.25, 19.3, -99.0, 19.55],
    ],
  },
};

function randomInBbox([minLng, minLat, maxLng, maxLat]: Bbox): LatLng {
  return {
    lng: minLng + Math.random() * (maxLng - minLng),
    lat: minLat + Math.random() * (maxLat - minLat),
  };
}

function randomPointInRegion(region: RegionKey): LatLng {
  const def = REGION_DEFS[region];
  const bbox = def.bboxes[Math.floor(Math.random() * def.bboxes.length)];
  return randomInBbox(bbox);
}

function buildBbox(center: LatLng, bboxDegrees: number) {
  return [
    center.lng - bboxDegrees,
    center.lat - bboxDegrees,
    center.lng + bboxDegrees,
    center.lat + bboxDegrees,
  ].join(",");
}

async function searchOnce(token: string, center: LatLng, bboxDegrees: number) {
  const bbox = buildBbox(center, bboxDegrees);
  const url = `${MAPILLARY_GRAPH_URL}?access_token=${token}&fields=id,geometry,thumb_2048_url&bbox=${bbox}&limit=50`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Mapillary API error", res.status, await res.text());
      return [];
    }
    const data = (await res.json()) as {
      data: { id: string; geometry: { coordinates: [number, number] }; thumb_2048_url: string }[];
    };
    return data.data ?? [];
  } catch (err) {
    console.error("Mapillary fetch failed", err);
    return [];
  }
}

/** 検索が完全に失敗した場合の最終フォールバック: 地方内の完全ランダム座標(画像なし) */
export function randomFallbackPoint(region: RegionKey): LatLng {
  return randomPointInRegion(region);
}

function haversineKmLocal(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * 指定した地方の中からランダムな座標を選び、その近くのMapillary画像を探す。
 * 見つからなければ地方内の別のランダム座標で再試行する（最大8回）。
 * avoidPoints に近すぎる(5km以内)候補は避けて、同じ場所が連続で選ばれないようにする。
 */
export async function findStreetPoint(
  token: string,
  region: RegionKey,
  avoidPoints: LatLng[] = []
): Promise<{ point: LatLng; imageUrl: string; imageId: string } | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const center = randomPointInRegion(region);
    const radius = attempt < 4 ? 0.03 : 0.08;
    const candidates = await searchOnce(token, center, radius);
    if (candidates.length === 0) continue;

    const shuffled = candidates.sort(() => Math.random() - 0.5);
    for (const c of shuffled) {
      const [lng, lat] = c.geometry.coordinates;
      const point = { lat, lng };
      const tooClose = avoidPoints.some((p) => haversineKmLocal(p, point) < 5);
      if (!tooClose) {
        return { point, imageUrl: c.thumb_2048_url, imageId: c.id };
      }
    }
    if (attempt === 7) {
      const [lng, lat] = shuffled[0].geometry.coordinates;
      return { point: { lat, lng }, imageUrl: shuffled[0].thumb_2048_url, imageId: shuffled[0].id };
    }
  }
  return null;
}

/**
 * AI逃走モードの移動先を決める。
 * 70%: 道路沿いに少し移動(nextRoadPoint) → その付近の画像を探す
 * 30%: 同じ地方内の完全にランダムな地点にジャンプ(単調な動きを避けるための演出)
 */
export async function moveAI(
  token: string,
  region: RegionKey,
  current: LatLng,
  avoidPoints: LatLng[]
): Promise<{ point: LatLng; imageUrl: string; imageId: string } | null> {
  const shouldJump = Math.random() < 0.3;

  if (!shouldJump) {
    const bearing = Math.random() * 360;
    const nextPoint = nextRoadPoint(current, bearing, 0.5 + Math.random() * 1.5);
    const nearby = await searchOnce(token, nextPoint, 0.025);
    if (nearby.length > 0) {
      const pick = nearby[Math.floor(Math.random() * nearby.length)];
      const [lng, lat] = pick.geometry.coordinates;
      return { point: { lat, lng }, imageUrl: pick.thumb_2048_url, imageId: pick.id };
    }
  }

  return findStreetPoint(token, region, avoidPoints);
}

/** 探索モード用: クリックした地点に一番近い画像を返す */
export async function nearestImage(
  token: string,
  point: LatLng
): Promise<{ point: LatLng; imageUrl: string; imageId: string } | null> {
  for (const radius of [0.01, 0.03, 0.08]) {
    const candidates = await searchOnce(token, point, radius);
    if (candidates.length === 0) continue;
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const [lng, lat] = c.geometry.coordinates;
      const d = haversineKmLocal(point, { lat, lng });
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    const [lng, lat] = best.geometry.coordinates;
    return { point: { lat, lng }, imageUrl: best.thumb_2048_url, imageId: best.id };
  }
  return null;
}

/**
 * 現在地から指定した方位・距離だけ離れた地点を球面三角法で計算する。
 * 以前はOSRMの公開デモサーバーで道路にスナップしていたが、商用利用不可のため廃止。
 * 移動先の座標をそのままMapillaryで検索すれば、Mapillaryの画像自体が
 * 道路・歩道沿いに撮影されているため、結果的に道路沿いの地点に着地する。
 */
export function nextRoadPoint(from: LatLng, bearingDeg: number, distanceKm = 0.8): LatLng {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = rad(from.lat);
  const lng1 = rad(from.lng);
  const brng = rad(bearingDeg);
  const dr = distanceKm / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
  const lng2 =
    lng1 +
    Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));

  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

export function haversineKm(a: LatLng, b: LatLng): number {
  return haversineKmLocal(a, b);
}

export async function reverseGeocode(point: LatLng): Promise<{ country?: string; state?: string; city?: string }> {
  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${point.lat}&lon=${point.lng}&zoom=10&accept-language=ja`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "GeoChase/0.2 (hobby project)" } });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      address?: { country?: string; state?: string; city?: string; town?: string; county?: string };
    };
    const addr = data.address ?? {};
    return { country: addr.country, state: addr.state, city: addr.city ?? addr.town ?? addr.county };
  } catch (err) {
    console.error("reverseGeocode failed", err);
    return {};
  }
}

/** 場所・地名に限定したヒント(都道府県/市区町村/緯度経度)のみを生成 */
export async function buildPlaceHints(point: LatLng): Promise<string[]> {
  const place = await reverseGeocode(point);
  const hints: string[] = [];
  if (place.country) hints.push(`国: ${place.country}`);
  if (place.state) hints.push(`都道府県・州: ${place.state}`);
  if (place.city) hints.push(`市区町村: ${place.city}`);
  hints.push(`おおよその緯度経度: ${point.lat.toFixed(1)}, ${point.lng.toFixed(1)}`);
  return hints;
}