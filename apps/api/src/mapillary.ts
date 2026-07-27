import type { LatLng, RegionKey, StreetSpot } from "./types";

const MAPILLARY_GRAPH_URL = "https://graph.mapillary.com/images";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const FETCH_TIMEOUT_MS = 8000;

// [minLng, minLat, maxLng, maxLat]
type Bbox = [number, number, number, number];

// scaleKm はスコア計算に使う「そのエリアの目安サイズ(km)」。
// 狭いエリアほど小さくすることで、範囲を絞ったときに満点が出にくくなる。
export const REGION_DEFS: Record<RegionKey, { label: string; bboxes: Bbox[]; scaleKm: number }> = {
  hokkaido: { label: "北海道", bboxes: [[139.3, 41.0, 145.8, 45.6]], scaleKm: 600 },
  tohoku: { label: "東北", bboxes: [[139.3, 36.8, 141.9, 41.6]], scaleKm: 500 },
  kanto: { label: "関東", bboxes: [[138.3, 34.8, 140.9, 37.2]], scaleKm: 300 },
  chubu: { label: "中部", bboxes: [[135.9, 34.6, 139.9, 38.0]], scaleKm: 450 },
  kinki: { label: "近畿", bboxes: [[134.7, 33.4, 136.5, 35.8]], scaleKm: 300 },
  chugoku: { label: "中国", bboxes: [[130.8, 33.7, 134.5, 35.8]], scaleKm: 400 },
  shikoku: { label: "四国", bboxes: [[132.0, 32.7, 134.8, 34.6]], scaleKm: 300 },
  kyushu_okinawa: { label: "九州・沖縄", bboxes: [[122.9, 24.0, 131.3, 34.0]], scaleKm: 900 },
  japan_wide: { label: "日本全国", bboxes: [[122.9, 24.0, 145.8, 45.6]], scaleKm: 2000 },
  world: {
    label: "世界",
    scaleKm: 15000,
    bboxes: [
      [139.4, 35.4, 140.0, 35.9], // 東京
      [-74.3, 40.6, -73.7, 40.9], // ニューヨーク
      [-0.4, 51.3, 0.2, 51.7], // ロンドン
      [2.1, 48.7, 2.5, 48.98], // パリ
      [150.9, -34.0, 151.4, -33.7], // シドニー
      [126.8, 37.4, 127.2, 37.7], // ソウル
      [13.2, 52.4, 13.6, 52.6], // ベルリン
      [4.7, 52.25, 5.0, 52.45], // アムステルダム
      [100.4, 13.6, 100.7, 13.9], // バンコク
      [-99.25, 19.3, -99.0, 19.55], // メキシコシティ
      [-43.4, -23.05, -43.1, -22.85], // リオデジャネイロ
      [18.3, -34.0, 18.6, -33.85], // ケープタウン
      [-123.3, 49.2, -122.9, 49.35], // バンクーバー
      [12.3, 41.8, 12.6, 42.0], // ローマ
    ],
  },
};

export function regionScaleKm(region: RegionKey): number {
  return REGION_DEFS[region]?.scaleKm ?? 200;
}

/* ------------------------------------------------------------------ *
 * 汎用ユーティリティ
 * ------------------------------------------------------------------ */

/** ネットワークが詰まってもDurable Objectのalarmが止まらないよう必ずタイムアウトさせる */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    console.error("fetch failed", url.split("?")[0], err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fisher-Yates。sort(() => Math.random() - 0.5) は偏るので使わない */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomInBbox([minLng, minLat, maxLng, maxLat]: Bbox): LatLng {
  return {
    lng: minLng + Math.random() * (maxLng - minLng),
    lat: minLat + Math.random() * (maxLat - minLat),
  };
}

function randomPointInRegion(region: RegionKey): LatLng {
  const def = REGION_DEFS[region] ?? REGION_DEFS.japan_wide;
  const bbox = def.bboxes[Math.floor(Math.random() * def.bboxes.length)];
  return randomInBbox(bbox);
}

function buildBbox(center: LatLng, deg: number) {
  // 緯度が上がるほど経度1度の実距離が縮むので、東西方向を補正して正方形に近づける
  const lngDeg = deg / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  return [center.lng - lngDeg, center.lat - deg, center.lng + lngDeg, center.lat + deg].join(",");
}

function haversineKmLocal(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function haversineKm(a: LatLng, b: LatLng): number {
  return haversineKmLocal(a, b);
}

/** aから見たbの方位角(度, 北=0, 時計回り) */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/* ------------------------------------------------------------------ *
 * Mapillary検索
 * ------------------------------------------------------------------ */

interface RawImage {
  id: string;
  geometry: { coordinates: [number, number] };
  computed_geometry?: { coordinates: [number, number] };
  thumb_original_url?: string;
  thumb_2048_url?: string;
  thumb_1024_url?: string;
  is_pano?: boolean;
  captured_at?: number;
  width?: number;
  height?: number;
  quality_score?: number;
}

function toSpot(img: RawImage): StreetSpot {
  const [lng, lat] = img.computed_geometry?.coordinates ?? img.geometry.coordinates;
  return {
    point: { lat, lng },
    // 静止画フォールバック用。看板が読めるよう可能な限り原寸に近いものを選ぶ
    imageUrl: img.thumb_original_url ?? img.thumb_2048_url ?? img.thumb_1024_url ?? "",
    imageId: img.id,
    isPano: Boolean(img.is_pano),
  };
}

async function searchOnce(token: string, center: LatLng, bboxDegrees: number, limit = 50): Promise<RawImage[]> {
  if (!token) {
    console.error("MAPILLARY_TOKEN is not configured");
    return [];
  }
  const fields =
    "id,geometry,computed_geometry,thumb_original_url,thumb_2048_url,thumb_1024_url,is_pano,captured_at,width,height,quality_score";
  const bbox = buildBbox(center, bboxDegrees);
  const url = `${MAPILLARY_GRAPH_URL}?access_token=${encodeURIComponent(token)}&fields=${fields}&bbox=${bbox}&limit=${limit}`;
  const res = await fetchWithTimeout(url);
  if (!res) return [];
  if (!res.ok) {
    console.error("Mapillary API error", res.status, (await res.text()).slice(0, 200));
    return [];
  }
  try {
    const data = (await res.json()) as { data?: RawImage[] };
    return (data.data ?? []).filter((d) => d?.geometry?.coordinates || d?.computed_geometry?.coordinates);
  } catch (err) {
    console.error("Mapillary JSON parse failed", err);
    return [];
  }
}

/**
 * 「遊べる画像」を上位に並べ替える。
 *  1. 360度パノラマ（視点を回せないと推理にならない）
 *  2. Mapillaryの品質スコアが高いもの
 *  3. 解像度が高いもの（看板や標識を読めるかどうかを左右する）
 * 同点のときはランダムなので、同じ場所ばかり出ることはない。
 */
function scoreImage(img: RawImage): number {
  const pano = img.is_pano ? 1_000_000 : 0;
  const quality = Math.max(0, Math.min(1, img.quality_score ?? 0.5)) * 100_000;
  const pixels = Math.min(1, (img.width ?? 2048) / 8000) * 10_000;
  return pano + quality + pixels;
}

function preferPanorama(images: RawImage[]): RawImage[] {
  // 先にシャッフルしてから安定ソートすることで、同スコア内の順序をランダムにする
  return shuffle(images).sort((a, b) => scoreImage(b) - scoreImage(a));
}

/** 検索が完全に失敗した場合の最終フォールバック: 地方内の完全ランダム座標(画像なし) */
export function randomFallbackPoint(region: RegionKey): LatLng {
  return randomPointInRegion(region);
}

/**
 * 指定した地方の中からランダムな座標を選び、その近くのMapillary画像を探す。
 * 見つからなければ地方内の別のランダム座標で再試行する（最大10回）。
 * avoidPoints に近すぎる候補は避けて、同じ場所が連続で選ばれないようにする。
 */
export async function findStreetPoint(
  token: string,
  region: RegionKey,
  avoidPoints: LatLng[] = []
): Promise<StreetSpot | null> {
  const minSeparationKm = region === "world" ? 50 : 5;
  let lastResort: StreetSpot | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const center = randomPointInRegion(region);
    // 序盤は狭く探して密集地(=見応えのある場所)を狙い、外れ続けたら広げる
    const radius = attempt < 4 ? 0.03 : attempt < 7 ? 0.08 : 0.15;
    const candidates = await searchOnce(token, center, radius);
    if (candidates.length === 0) continue;

    const ordered = preferPanorama(candidates);
    if (!lastResort) lastResort = toSpot(ordered[0]);

    for (const c of ordered) {
      const spot = toSpot(c);
      const tooClose = avoidPoints.some((p) => haversineKmLocal(p, spot.point) < minSeparationKm);
      if (!tooClose) return spot;
    }
  }
  return lastResort;
}

/**
 * AI逃走モードの移動先を決める。
 * ・75%: 直前の進行方向を引き継いで前進（±60度のブレ）→ 逃走ルートが直線的に読める
 * ・25%: 同じ地方内へワープ（追跡が完全に詰むのを防ぐ揺さぶり）
 * 画像が見つからなければ距離を変えて数回リトライする。
 */
export async function moveAI(
  token: string,
  region: RegionKey,
  current: LatLng,
  avoidPoints: LatLng[],
  lastBearing: number | null
): Promise<(StreetSpot & { bearing: number }) | null> {
  const shouldJump = Math.random() < 0.25;

  if (!shouldJump) {
    const base = lastBearing ?? Math.random() * 360;
    for (const distanceKm of [1.2, 2.4, 0.6, 4.0]) {
      const bearing = (base + (Math.random() * 120 - 60) + 360) % 360;
      const nextPoint = destinationPoint(current, bearing, distanceKm);
      const nearby = await searchOnce(token, nextPoint, 0.02, 30);
      if (nearby.length > 0) {
        const spot = toSpot(preferPanorama(nearby)[0]);
        return { ...spot, bearing: bearingDeg(current, spot.point) };
      }
    }
  }

  const jumped = await findStreetPoint(token, region, avoidPoints);
  if (!jumped) return null;
  return { ...jumped, bearing: bearingDeg(current, jumped.point) };
}

/** 探索モード用: クリックした地点に一番近い画像を返す */
export async function nearestImage(token: string, point: LatLng): Promise<StreetSpot | null> {
  for (const radius of [0.008, 0.02, 0.06, 0.15]) {
    const candidates = await searchOnce(token, point, radius);
    if (candidates.length === 0) continue;

    // まずパノラマだけで最寄りを探し、無ければ平面写真から選ぶ
    const panos = candidates.filter((c) => c.is_pano);
    const pool = panos.length > 0 ? panos : candidates;

    let best = pool[0];
    let bestDist = Infinity;
    for (const c of pool) {
      const spot = toSpot(c);
      const d = haversineKmLocal(point, spot.point);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return toSpot(best);
  }
  return null;
}

/**
 * 現在地から指定した方位・距離だけ離れた地点を球面三角法で計算する。
 * 以前はOSRMの公開デモサーバーで道路にスナップしていたが、商用利用不可のため廃止。
 * 移動先の座標をそのままMapillaryで検索すれば、Mapillaryの画像自体が
 * 道路・歩道沿いに撮影されているため、結果的に道路沿いの地点に着地する。
 */
export function destinationPoint(from: LatLng, bearingDegrees: number, distanceKm = 0.8): LatLng {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = rad(from.lat);
  const lng1 = rad(from.lng);
  const brng = rad(bearingDegrees);
  const dr = distanceKm / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
  const lng2 =
    lng1 + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));

  return { lat: (lat2 * 180) / Math.PI, lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** 旧名との互換のため残す */
export const nextRoadPoint = destinationPoint;

/* ------------------------------------------------------------------ *
 * 逆ジオコーディング（KVキャッシュ付き）
 * ------------------------------------------------------------------ */

interface Place {
  country?: string;
  state?: string;
  city?: string;
}

/**
 * Nominatimは「1リクエスト/秒」「User-Agent必須」が利用規約。
 * ラウンドごとに素で叩くと規約違反になりやすいので、
 * 小数第2位(約1km四方)に丸めたキーでKVに30日キャッシュする。
 */
export async function reverseGeocode(point: LatLng, kv?: KVNamespace): Promise<Place> {
  const key = `geo:${point.lat.toFixed(2)},${point.lng.toFixed(2)}`;

  if (kv) {
    try {
      const cached = await kv.get<Place>(key, "json");
      if (cached) return cached;
    } catch (err) {
      console.error("KV read failed", err);
    }
  }

  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${point.lat}&lon=${point.lng}&zoom=10&accept-language=ja`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "GeoChase/1.0 (https://geochase.pages.dev)" },
  });
  if (!res || !res.ok) return {};

  try {
    const data = (await res.json()) as {
      address?: {
        country?: string;
        state?: string;
        province?: string;
        city?: string;
        town?: string;
        village?: string;
        county?: string;
      };
    };
    const addr = data.address ?? {};
    const place: Place = {
      country: addr.country,
      state: addr.state ?? addr.province,
      city: addr.city ?? addr.town ?? addr.village ?? addr.county,
    };
    if (kv) {
      // 待たずに書き込む（DOのalarm処理を遅らせない）
      kv.put(key, JSON.stringify(place), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
    }
    return place;
  } catch (err) {
    console.error("reverseGeocode parse failed", err);
    return {};
  }
}

/**
 * 段階的に開示するヒントを、ゆるい順→具体的な順で生成する。
 * 1つ目から答えが分かってしまわないよう、順序と粒度を固定している。
 */
export async function buildPlaceHints(point: LatLng, kv?: KVNamespace): Promise<string[]> {
  const place = await reverseGeocode(point, kv);
  const hints: string[] = [];

  if (place.country) hints.push(`国・地域: ${place.country}`);
  hints.push(`おおよその緯度: ${Math.round(point.lat)}° / 経度: ${Math.round(point.lng)}°`);
  if (place.state) hints.push(`都道府県・州: ${place.state}`);
  if (place.city) hints.push(`市区町村: ${place.city}`);
  hints.push(`詳しい座標: ${point.lat.toFixed(2)}, ${point.lng.toFixed(2)}`);

  return hints;
}