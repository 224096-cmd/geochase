import type { LatLng, RegionKey, StreetSpot } from "./types";

const MAPILLARY_GRAPH_URL = "https://graph.mapillary.com/images";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const FETCH_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ *
 * 「遊べる地点」の条件
 *
 * ここを満たさない地点は採用しない。
 * これが無いと、写真が1〜2枚しか無い袋小路に出て
 * 「少ししか動けない・視点も回せない」状態になる。
 * ------------------------------------------------------------------ */

/** 密度を測る半径(km)。この中に何枚あるかで「歩き回れるか」を判断する */
const WALK_RADIUS_KM = 0.15;
/** 半径内に最低これだけ画像が必要 */
const MIN_NEIGHBORS = 6;
/** 同じ撮影シーケンス(連続した並び)の最低枚数。前後に進めるかの目安 */
const MIN_SEQUENCE_LENGTH = 8;

/* ------------------------------------------------------------------ *
 * 画質の条件
 *
 * Mapillaryは投稿型なので、2013年頃のガラケー画質から
 * 最新の8K 360度カメラまで玉石混交。看板を読ませたいなら
 * 「解像度」と「撮影年」で足切りするのがいちばん効く。
 * ------------------------------------------------------------------ */

/** 採用条件を段階的にゆるめる。上から順に試し、見つかった時点で採用する */
interface QualityTier {
  label: string;
  /** 360度パノラマ必須か */
  pano: boolean;
  /** 元画像の最低横ピクセル数 */
  minWidth: number;
  /** 何年前までの撮影を許容するか（0 = 制限なし） */
  freshYears: number;
  /** 周囲の画像密度・シーケンス長の条件を課すか */
  walkable: boolean;
}

const QUALITY_TIERS: QualityTier[] = [
  // 5760x2880 = Insta360 X3 / GoPro Max クラス。看板がはっきり読める
  { label: "best", pano: true, minWidth: 5760, freshYears: 5, walkable: true },
  { label: "good", pano: true, minWidth: 4096, freshYears: 8, walkable: true },
  { label: "fair", pano: true, minWidth: 2048, freshYears: 12, walkable: true },
  // ここから平面写真も許容
  { label: "flat", pano: false, minWidth: 2560, freshYears: 10, walkable: true },
  { label: "any-walkable", pano: false, minWidth: 1600, freshYears: 0, walkable: true },
  // 最後の妥協。何も見つからないよりはマシ
  { label: "any", pano: false, minWidth: 0, freshYears: 0, walkable: false },
];

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

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
  /** 撮影シーケンスID。ここが同じ画像同士は前後に歩いて移動できる */
  sequence?: string;
}

function coordOf(img: RawImage): LatLng {
  const [lng, lat] = img.computed_geometry?.coordinates ?? img.geometry.coordinates;
  return { lat, lng };
}

function toSpot(img: RawImage, neighbors?: number): StreetSpot {
  return {
    point: coordOf(img),
    // 静止画フォールバック用。看板が読めるよう可能な限り原寸に近いものを選ぶ
    imageUrl: img.thumb_original_url ?? img.thumb_2048_url ?? img.thumb_1024_url ?? "",
    imageId: img.id,
    isPano: Boolean(img.is_pano),
    sequenceId: img.sequence,
    neighbors,
    width: img.width,
    capturedAt: img.captured_at,
  };
}

/** sequence を含めて取得する。前後に歩けるかの判定に必須 */
const IMAGE_FIELDS =
  "id,geometry,computed_geometry,thumb_original_url,thumb_2048_url,thumb_1024_url,is_pano,captured_at,width,height,quality_score,sequence";

async function searchOnce(token: string, center: LatLng, bboxDegrees: number, limit = 100): Promise<RawImage[]> {
  if (!token) {
    console.error("MAPILLARY_TOKEN is not configured");
    return [];
  }
  const bbox = buildBbox(center, bboxDegrees);
  const url = `${MAPILLARY_GRAPH_URL}?access_token=${encodeURIComponent(token)}&fields=${IMAGE_FIELDS}&bbox=${bbox}&limit=${limit}`;
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

/* ------------------------------------------------------------------ *
 * 「歩き回れる地点」の評価
 * ------------------------------------------------------------------ */

/** 検索結果1回ぶんから、周辺密度とシーケンス長をまとめて出す */
function analysePool(pool: RawImage[]) {
  const points = pool.map(coordOf);
  const sequenceLength = new Map<string, number>();
  for (const img of pool) {
    const key = img.sequence ?? "";
    if (!key) continue;
    sequenceLength.set(key, (sequenceLength.get(key) ?? 0) + 1);
  }

  const neighborsOf = (index: number) => {
    const target = points[index];
    let n = 0;
    for (let i = 0; i < points.length; i++) {
      if (i === index) continue;
      if (haversineKmLocal(target, points[i]) <= WALK_RADIUS_KM) n++;
    }
    return n;
  };

  return { neighborsOf, sequenceLength };
}

/** 何年前の写真か */
function ageYears(img: RawImage): number {
  if (!img.captured_at) return 99;
  return (Date.now() - img.captured_at) / YEAR_MS;
}

/**
 * 地点としての「遊べる度」を採点する。重みの大きい順に:
 *  1. 360度パノラマ（視点を回せないと推理にならない）
 *  2. 解像度（看板・標識が読めるかを直接左右する。ここを最重視した）
 *  3. 撮影の新しさ（新しいほどカメラが良く、街並みも現在に近い）
 *  4. 周囲150m以内の画像枚数（多いほど歩き回れる）
 *  5. 同じシーケンスの長さ（長いほど前後にどこまでも進める）
 *  6. Mapillaryの品質スコア
 */
function playabilityScore(img: RawImage, neighbors: number, seqLength: number): number {
  const pano = img.is_pano ? 4_000_000 : 0;

  // 8000px で満点。2048px なら 1/4 しか入らない
  const resolution = Math.min(1, (img.width ?? 1024) / 8000) * 1_500_000;

  // 1年以内なら満点、10年前で0
  const freshness = Math.max(0, 1 - ageYears(img) / 10) * 900_000;

  const density = Math.min(neighbors, 30) * 20_000;
  const sequence = Math.min(seqLength, 30) * 13_000;
  const quality = Math.max(0, Math.min(1, img.quality_score ?? 0.5)) * 200_000;

  return pano + resolution + freshness + density + sequence + quality;
}

interface RankedSpot {
  spot: StreetSpot;
  neighbors: number;
  seqLength: number;
  ageYears: number;
  score: number;
}

/** 検索結果を「遊べる順」に並べ替える。同点はランダムなので同じ場所ばかりにはならない */
function rankSpots(pool: RawImage[]): RankedSpot[] {
  if (pool.length === 0) return [];
  const shuffled = shuffle(pool);
  const { neighborsOf, sequenceLength } = analysePool(shuffled);

  return shuffled
    .map((img, i) => {
      const neighbors = neighborsOf(i);
      const seqLength = sequenceLength.get(img.sequence ?? "") ?? 1;
      return {
        spot: toSpot(img, neighbors),
        neighbors,
        seqLength,
        ageYears: ageYears(img),
        score: playabilityScore(img, neighbors, seqLength),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** そのティアの条件を満たしているか */
function meetsTier(r: RankedSpot, tier: QualityTier): boolean {
  if (tier.pano && !r.spot.isPano) return false;
  if (tier.minWidth > 0 && (r.spot.width ?? 0) < tier.minWidth) return false;
  if (tier.freshYears > 0 && r.ageYears > tier.freshYears) return false;
  if (tier.walkable && (r.neighbors < MIN_NEIGHBORS || r.seqLength < MIN_SEQUENCE_LENGTH)) return false;
  return true;
}

/** 候補の中から、条件のきついティアから順に探す */
function pickByTier(ranked: RankedSpot[], tiers: QualityTier[], accept: (r: RankedSpot) => boolean): RankedSpot | null {
  for (const tier of tiers) {
    const hit = ranked.find((r) => meetsTier(r, tier) && accept(r));
    if (hit) return hit;
  }
  return null;
}

/** 検索が完全に失敗した場合の最終フォールバック: 地方内の完全ランダム座標(画像なし) */
export function randomFallbackPoint(region: RegionKey): LatLng {
  return randomPointInRegion(region);
}

/**
 * 指定した地方の中からランダムな座標を選び、その近くのMapillary画像を探す。
 *
 * 探索は「良い条件で何度も引き直す」方式。
 *   序盤(0-5回目)  … QUALITY_TIERS の上位2段だけ（高解像度の360度写真）
 *   中盤(6-9回目)  … 上位4段まで
 *   終盤(10回目〜) … 全段（最後は妥協）
 * 引き直す回数を増やすほど画質は上がるが、そのぶん探索に時間がかかる。
 */
export async function findStreetPoint(
  token: string,
  region: RegionKey,
  avoidPoints: LatLng[] = []
): Promise<StreetSpot | null> {
  const minSeparationKm = region === "world" ? 50 : 5;
  let lastResort: StreetSpot | null = null;

  for (let attempt = 0; attempt < 14; attempt++) {
    const center = randomPointInRegion(region);
    // 序盤は狭く探して密集地(=見応えのある場所)を狙い、外れ続けたら広げる
    const radius = attempt < 5 ? 0.03 : attempt < 10 ? 0.08 : 0.15;
    const candidates = await searchOnce(token, center, radius);
    if (candidates.length === 0) continue;

    const ranked = rankSpots(candidates);
    if (!lastResort && ranked[0]) lastResort = ranked[0].spot;

    const depth = attempt < 6 ? 2 : attempt < 10 ? 4 : QUALITY_TIERS.length;
    const notTooClose = (r: RankedSpot) =>
      !avoidPoints.some((p) => haversineKmLocal(p, r.spot.point) < minSeparationKm);

    const hit = pickByTier(ranked, QUALITY_TIERS.slice(0, depth), notTooClose);
    if (hit) return hit.spot;
  }
  return lastResort;
}

/* ------------------------------------------------------------------ *
 * 逃走者の移動ロジック（ルールベース。機械学習・LLMは使っていない）
 * ------------------------------------------------------------------ */

/**
 * どの方角へ逃げるかを決める。
 *  - 追跡者の回答がまだ遠い(30km超) … これまでの進行方向を維持して直線的に逃げる
 *  - 詰められている(30km以内)       … 一番近い回答から見て「遠ざかる向き」へ舵を切る
 * どちらも±ブレを入れて、完全に読み切られないようにする。
 */
function escapeBearing(current: LatLng, pursuers: LatLng[], lastBearing: number | null): { bearing: number; pressureKm: number } {
  const drift = () => Math.random() * 120 - 60;

  if (pursuers.length === 0) {
    return { bearing: ((lastBearing ?? Math.random() * 360) + drift() + 360) % 360, pressureKm: Infinity };
  }

  let nearest = pursuers[0];
  let pressureKm = Infinity;
  for (const p of pursuers) {
    const d = haversineKmLocal(p, current);
    if (d < pressureKm) {
      pressureKm = d;
      nearest = p;
    }
  }

  if (pressureKm > 30) {
    return { bearing: ((lastBearing ?? Math.random() * 360) + drift() + 360) % 360, pressureKm };
  }

  // 追跡者 → 現在地 の向きへ進めば、そのまま離れていく
  const away = bearingDeg(nearest, current);
  // 詰められているほどブレを小さくして、まっすぐ逃げる
  const spread = pressureKm < 5 ? 40 : 80;
  return { bearing: (away + (Math.random() * spread - spread / 2) + 360) % 360, pressureKm };
}

/**
 * 逃走者の移動先を決める。
 *  ・通常     : 逃走方向へ 0.6〜4km 前進（見つかりにくいが追える距離）
 *  ・詰められた: 遠くへワープする確率が上がる
 * 画像が見つからなければ距離を変えて数回リトライする。
 *
 * pursuers には「そのラウンドで実際に送られてきた回答座標」を渡す。
 * これにより、当てずっぽうでなく“追われている方向から離れる”動きになる。
 */
export async function moveAI(
  token: string,
  region: RegionKey,
  current: LatLng,
  avoidPoints: LatLng[],
  lastBearing: number | null,
  pursuers: LatLng[] = []
): Promise<(StreetSpot & { bearing: number }) | null> {
  const { bearing: baseBearing, pressureKm } = escapeBearing(current, pursuers, lastBearing);

  // 追い詰められているほどワープしやすくする（0.2 〜 0.55）
  const jumpChance = pressureKm < 5 ? 0.55 : pressureKm < 30 ? 0.35 : 0.2;
  const shouldJump = Math.random() < jumpChance;

  if (!shouldJump) {
    // 近距離から順に試す。詰められているときは遠くから試す
    const steps = pressureKm < 5 ? [4.0, 2.4, 1.2, 0.6] : [1.2, 2.4, 0.6, 4.0];
    for (const distanceKm of steps) {
      const bearing = (baseBearing + (Math.random() * 30 - 15) + 360) % 360;
      const nextPoint = destinationPoint(current, bearing, distanceKm);
      // 半径を少し広げて候補を増やし、密度判定が効くようにする
      const nearby = await searchOnce(token, nextPoint, 0.03, 60);
      if (nearby.length === 0) continue;

      const ranked = rankSpots(nearby);
      // 移動先も同じ基準で選ぶ。ここで妥協すると画質がガタ落ちする
      const picked = pickByTier(ranked, QUALITY_TIERS, () => true) ?? ranked[0];
      if (!picked) continue;
      return { ...picked.spot, bearing: bearingDeg(current, picked.spot.point) };
    }
  }

  const jumped = await findStreetPoint(token, region, avoidPoints);
  if (!jumped) return null;
  return { ...jumped, bearing: bearingDeg(current, jumped.point) };
}

/* ------------------------------------------------------------------ *
 * 任意地点の画像探索（下見・別の道へ・360度を探す・鮮明な写真を探す）
 * ------------------------------------------------------------------ */

export interface NearestOptions {
  /** 360度パノラマだけを対象にする */
  panoOnly?: boolean;
  /** 元画像の最低横ピクセル数。「もっと鮮明な写真を探す」で使う */
  minWidth?: number;
  /** この画像IDは選ばない（同じ場所に戻らないように） */
  excludeId?: string;
  /** このシーケンスは選ばない（別の道へ移りたいとき） */
  excludeSequenceId?: string;
  /** これより近い画像は選ばない(km)。0.05なら50m以上離れた画像になる */
  minKm?: number;
  /** 検索半径(度)の開始値 */
  startRadius?: number;
}

/** クリック地点／現在地に近い画像を返す。条件に合うものが無ければ段階的にゆるめる */
export async function nearestImage(token: string, point: LatLng, opts: NearestOptions = {}): Promise<StreetSpot | null> {
  const { panoOnly = false, minWidth = 0, excludeId, excludeSequenceId, minKm = 0, startRadius = 0.008 } = opts;
  const radii = [startRadius, startRadius * 2.5, startRadius * 7, startRadius * 18];

  let relaxed: StreetSpot | null = null;

  for (const radius of radii) {
    const candidates = await searchOnce(token, point, radius);
    if (candidates.length === 0) continue;

    const usable = candidates.filter((c) => {
      if (excludeId && c.id === excludeId) return false;
      if (excludeSequenceId && c.sequence && c.sequence === excludeSequenceId) return false;
      return true;
    });
    if (usable.length === 0) continue;

    let pool = usable;
    if (panoOnly) pool = pool.filter((c) => c.is_pano);
    if (minWidth > 0) pool = pool.filter((c) => (c.width ?? 0) >= minWidth);
    const target = pool.length > 0 ? pool : usable;

    // 距離順に見て、minKm を満たす最初のものを採用する
    const sorted = target
      .map((c) => ({ img: c, d: haversineKmLocal(point, coordOf(c)) }))
      .sort((a, b) => a.d - b.d);

    if (!relaxed && sorted[0]) relaxed = toSpot(sorted[0].img);

    const hit = sorted.find((s) => s.d >= minKm);
    if (hit) return toSpot(hit.img);
  }

  return relaxed;
}

/**
 * 現在地から指定した方位・距離だけ離れた地点を球面三角法で計算する。
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