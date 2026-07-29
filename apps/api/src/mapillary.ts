import type { LatLng, RegionKey, StreetSpot } from "./types";

const MAPILLARY_GRAPH_URL = "https://graph.mapillary.com/images";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const FETCH_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ *
 * 「遊べる地点」の条件
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
 * 「鮮明な写真を探す」ボタンを廃止したぶん、最初から高解像度だけを
 * 引くように基準を1段引き上げてある。
 * ------------------------------------------------------------------ */

interface QualityTier {
  label: string;
  pano: boolean;
  minWidth: number;
  freshYears: number;
  walkable: boolean;
}

const QUALITY_TIERS: QualityTier[] = [
  // 5760x2880 = Insta360 X3 / GoPro Max クラス。看板がはっきり読める
  { label: "best", pano: true, minWidth: 5760, freshYears: 6, walkable: true },
  { label: "good", pano: true, minWidth: 4096, freshYears: 10, walkable: true },
  { label: "fair", pano: true, minWidth: 3000, freshYears: 14, walkable: true },
  // ここから平面写真も許容
  { label: "flat", pano: false, minWidth: 3000, freshYears: 12, walkable: true },
  { label: "any-walkable", pano: false, minWidth: 2048, freshYears: 0, walkable: true },
  // 最後の妥協。何も見つからないよりはマシ
  { label: "any", pano: false, minWidth: 0, freshYears: 0, walkable: false },
];

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// [minLng, minLat, maxLng, maxLat]
type Bbox = [number, number, number, number];

/**
 * hintLevel = 最初に出すヒントの粒度。
 *   0 … 国から出す（世界）
 *   1 … 都道府県・州から出す（国や地方を指定済み＝国は自明）
 *   2 … 市区町村から出す（都道府県を指定済み）
 */
interface RegionDef {
  label: string;
  group: string;
  bboxes: Bbox[];
  scaleKm: number;
  hintLevel: 0 | 1 | 2;
}

/**
 * 島が散らばる地域は bbox を分割してある。
 * 1つの大きな四角にすると海ばかり引いて、地点探索が何度も空振りするため。
 */
export const REGION_DEFS: Record<string, RegionDef> = {
  /* ---------- まとめ ---------- */
  japan_wide: { label: "日本全国", group: "まとめ", scaleKm: 2000, hintLevel: 1,
    bboxes: [[130.0, 31.0, 141.0, 43.5], [139.0, 34.9, 140.9, 36.3], [135.0, 34.2, 136.5, 35.8], [130.2, 32.5, 131.6, 34.0]] },
  world: { label: "世界", group: "まとめ", scaleKm: 15000, hintLevel: 0,
    bboxes: [
      [139.4, 35.4, 140.0, 35.9], [-74.3, 40.6, -73.7, 40.9], [-0.4, 51.3, 0.2, 51.7],
      [2.1, 48.7, 2.5, 48.98], [150.9, -34.0, 151.4, -33.7], [126.8, 37.4, 127.2, 37.7],
      [13.2, 52.4, 13.6, 52.6], [4.7, 52.25, 5.0, 52.45], [100.4, 13.6, 100.7, 13.9],
      [-99.25, 19.3, -99.0, 19.55], [-43.4, -23.05, -43.1, -22.85], [18.3, -34.0, 18.6, -33.85],
      [-123.3, 49.2, -122.9, 49.35], [12.3, 41.8, 12.6, 42.0], [121.4, 25.0, 121.65, 25.15],
      [-118.5, 33.9, -118.1, 34.15], [11.4, 48.09, 11.7, 48.2], [-3.8, 40.35, -3.6, 40.5],
    ] },

  /* ---------- 地方 ---------- */
  r_hokkaido: { label: "北海道地方", group: "地方", scaleKm: 600, hintLevel: 1,
    bboxes: [[140.6, 42.6, 142.2, 43.6], [140.0, 41.4, 141.6, 42.6], [141.4, 43.5, 143.2, 45.5], [142.5, 42.8, 145.6, 44.4]] },
  r_tohoku: { label: "東北地方", group: "地方", scaleKm: 500, hintLevel: 1,
    bboxes: [[139.5, 40.2, 141.7, 41.6], [140.6, 38.7, 142.1, 40.5], [140.3, 37.7, 141.7, 39.0], [139.1, 36.8, 141.1, 38.0]] },
  r_kanto: { label: "関東地方", group: "地方", scaleKm: 300, hintLevel: 1,
    bboxes: [[139.0, 35.4, 140.0, 35.95], [139.6, 35.1, 140.2, 35.7], [139.7, 35.6, 140.9, 36.4], [139.2, 36.1, 140.3, 37.0]] },
  r_chubu: { label: "中部地方", group: "地方", scaleKm: 450, hintLevel: 1,
    bboxes: [[136.7, 34.9, 137.9, 35.4], [137.4, 34.6, 139.2, 35.5], [137.3, 35.5, 138.7, 36.8], [136.6, 36.4, 137.9, 37.1], [138.7, 37.3, 139.8, 38.3]] },
  r_kinki: { label: "近畿地方", group: "地方", scaleKm: 300, hintLevel: 1,
    bboxes: [[135.1, 34.3, 135.8, 34.85], [135.0, 34.6, 135.9, 35.1], [134.6, 34.6, 135.5, 35.0], [135.7, 34.9, 136.3, 35.4], [135.7, 34.4, 136.2, 34.8]] },
  r_chugoku: { label: "中国地方", group: "地方", scaleKm: 400, hintLevel: 1,
    bboxes: [[132.2, 34.3, 132.6, 34.5], [133.7, 34.6, 134.1, 34.8], [131.4, 34.1, 132.1, 34.3], [133.1, 35.4, 134.3, 35.6], [132.8, 35.3, 133.3, 35.5]] },
  r_shikoku: { label: "四国地方", group: "地方", scaleKm: 300, hintLevel: 1,
    bboxes: [[134.4, 34.0, 134.7, 34.15], [133.9, 34.2, 134.2, 34.4], [132.6, 33.7, 133.0, 33.95], [133.4, 33.4, 133.7, 33.65]] },
  r_kyushu: { label: "九州・沖縄地方", group: "地方", scaleKm: 900, hintLevel: 1,
    bboxes: [[130.3, 33.5, 130.6, 33.7], [130.6, 32.7, 131.0, 33.0], [130.4, 31.5, 130.7, 31.7], [131.4, 31.85, 131.6, 32.0], [127.6, 26.15, 128.0, 26.5]] },

  /* ---------- 都道府県（hintLevel:2 = 市区町村から出す） ---------- */
  hokkaido: { label: "北海道", group: "北海道・東北", scaleKm: 500, hintLevel: 2,
    bboxes: [[140.9, 42.85, 141.7, 43.35], [140.0, 41.7, 141.0, 42.4], [141.2, 43.6, 142.0, 44.5], [143.9, 42.9, 144.6, 43.3], [144.2, 43.7, 144.5, 44.0]] },
  aomori: { label: "青森県", group: "北海道・東北", scaleKm: 120, hintLevel: 2,
    bboxes: [[140.6, 40.7, 140.95, 40.95], [141.3, 40.45, 141.65, 40.7], [140.4, 40.5, 140.7, 40.7]] },
  iwate: { label: "岩手県", group: "北海道・東北", scaleKm: 150, hintLevel: 2,
    bboxes: [[141.0, 39.6, 141.3, 39.85], [141.6, 39.55, 142.0, 39.8], [141.0, 39.0, 141.3, 39.3]] },
  miyagi: { label: "宮城県", group: "北海道・東北", scaleKm: 110, hintLevel: 2,
    bboxes: [[140.75, 38.2, 141.15, 38.4], [141.2, 38.35, 141.5, 38.6], [140.85, 38.0, 141.2, 38.2]] },
  akita: { label: "秋田県", group: "北海道・東北", scaleKm: 130, hintLevel: 2,
    bboxes: [[140.0, 39.6, 140.35, 39.85], [140.4, 39.3, 140.7, 39.55], [140.05, 40.15, 140.4, 40.35]] },
  yamagata: { label: "山形県", group: "北海道・東北", scaleKm: 110, hintLevel: 2,
    bboxes: [[140.2, 38.2, 140.5, 38.4], [139.8, 38.7, 140.0, 38.9], [140.0, 37.85, 140.3, 38.05]] },
  fukushima: { label: "福島県", group: "北海道・東北", scaleKm: 130, hintLevel: 2,
    bboxes: [[140.35, 37.7, 140.6, 37.85], [139.9, 37.45, 140.15, 37.6], [140.85, 37.0, 141.05, 37.2]] },

  ibaraki: { label: "茨城県", group: "関東", scaleKm: 90, hintLevel: 2,
    bboxes: [[140.3, 36.3, 140.6, 36.45], [140.05, 36.05, 140.3, 36.2], [140.4, 36.55, 140.7, 36.75]] },
  tochigi: { label: "栃木県", group: "関東", scaleKm: 90, hintLevel: 2,
    bboxes: [[139.8, 36.5, 140.1, 36.7], [139.6, 36.3, 139.9, 36.45], [139.6, 36.7, 139.85, 36.85]] },
  gunma: { label: "群馬県", group: "関東", scaleKm: 90, hintLevel: 2,
    bboxes: [[139.0, 36.3, 139.3, 36.45], [139.2, 36.15, 139.5, 36.3], [138.85, 36.5, 139.1, 36.7]] },
  saitama: { label: "埼玉県", group: "関東", scaleKm: 70, hintLevel: 2,
    bboxes: [[139.55, 35.83, 139.75, 35.95], [139.35, 35.85, 139.6, 36.0], [139.05, 35.95, 139.35, 36.12]] },
  chiba: { label: "千葉県", group: "関東", scaleKm: 90, hintLevel: 2,
    bboxes: [[139.95, 35.55, 140.2, 35.72], [140.05, 35.65, 140.35, 35.85], [139.85, 35.3, 140.1, 35.5]] },
  tokyo: { label: "東京都", group: "関東", scaleKm: 45, hintLevel: 2,
    bboxes: [[139.65, 35.63, 139.82, 35.75], [139.5, 35.65, 139.68, 35.76], [139.28, 35.68, 139.5, 35.78]] },
  kanagawa: { label: "神奈川県", group: "関東", scaleKm: 70, hintLevel: 2,
    bboxes: [[139.55, 35.42, 139.75, 35.56], [139.6, 35.24, 139.75, 35.37], [139.3, 35.3, 139.55, 35.45]] },

  niigata: { label: "新潟県", group: "中部", scaleKm: 140, hintLevel: 2,
    bboxes: [[138.95, 37.85, 139.2, 38.0], [138.2, 37.4, 138.5, 37.6], [139.0, 37.5, 139.3, 37.7]] },
  toyama: { label: "富山県", group: "中部", scaleKm: 70, hintLevel: 2,
    bboxes: [[137.15, 36.65, 137.35, 36.78], [136.95, 36.7, 137.15, 36.85], [137.2, 36.45, 137.45, 36.6]] },
  ishikawa: { label: "石川県", group: "中部", scaleKm: 90, hintLevel: 2,
    bboxes: [[136.6, 36.5, 136.8, 36.65], [136.8, 36.75, 137.05, 36.95], [136.9, 37.2, 137.15, 37.4]] },
  fukui: { label: "福井県", group: "中部", scaleKm: 80, hintLevel: 2,
    bboxes: [[136.15, 36.0, 136.35, 36.15], [136.0, 35.6, 136.2, 35.75], [135.7, 35.45, 135.95, 35.6]] },
  yamanashi: { label: "山梨県", group: "中部", scaleKm: 70, hintLevel: 2,
    bboxes: [[138.5, 35.62, 138.75, 35.75], [138.4, 35.5, 138.6, 35.65], [138.7, 35.45, 138.9, 35.6]] },
  nagano: { label: "長野県", group: "中部", scaleKm: 130, hintLevel: 2,
    bboxes: [[138.15, 36.6, 138.35, 36.75], [137.9, 36.15, 138.15, 36.3], [138.15, 35.95, 138.4, 36.1]] },
  gifu: { label: "岐阜県", group: "中部", scaleKm: 100, hintLevel: 2,
    bboxes: [[136.7, 35.35, 136.95, 35.5], [136.5, 35.4, 136.75, 35.55], [137.15, 36.1, 137.35, 36.25]] },
  shizuoka: { label: "静岡県", group: "中部", scaleKm: 110, hintLevel: 2,
    bboxes: [[138.3, 34.95, 138.5, 35.05], [137.65, 34.65, 137.85, 34.8], [138.9, 35.05, 139.1, 35.2]] },
  aichi: { label: "愛知県", group: "中部", scaleKm: 80, hintLevel: 2,
    bboxes: [[136.85, 35.1, 137.05, 35.25], [137.1, 34.95, 137.3, 35.1], [137.35, 34.7, 137.55, 34.82]] },

  mie: { label: "三重県", group: "近畿", scaleKm: 100, hintLevel: 2,
    bboxes: [[136.45, 34.65, 136.65, 34.8], [136.4, 34.45, 136.6, 34.6], [136.7, 34.45, 136.9, 34.6]] },
  shiga: { label: "滋賀県", group: "近畿", scaleKm: 60, hintLevel: 2,
    bboxes: [[135.85, 35.0, 136.05, 35.15], [136.2, 35.25, 136.4, 35.4], [135.95, 34.95, 136.15, 35.05]] },
  kyoto: { label: "京都府", group: "近畿", scaleKm: 70, hintLevel: 2,
    bboxes: [[135.72, 34.98, 135.82, 35.06], [135.6, 34.85, 135.78, 34.98], [135.2, 35.45, 135.4, 35.58]] },
  osaka: { label: "大阪府", group: "近畿", scaleKm: 45, hintLevel: 2,
    bboxes: [[135.47, 34.65, 135.58, 34.73], [135.5, 34.55, 135.65, 34.66], [135.55, 34.75, 135.72, 34.85]] },
  hyogo: { label: "兵庫県", group: "近畿", scaleKm: 100, hintLevel: 2,
    bboxes: [[135.15, 34.66, 135.3, 34.75], [134.65, 34.78, 134.9, 34.9], [134.9, 34.65, 135.1, 34.78]] },
  nara: { label: "奈良県", group: "近畿", scaleKm: 60, hintLevel: 2,
    bboxes: [[135.75, 34.65, 135.9, 34.75], [135.75, 34.45, 135.9, 34.58], [135.85, 34.28, 136.0, 34.4]] },
  wakayama: { label: "和歌山県", group: "近畿", scaleKm: 80, hintLevel: 2,
    bboxes: [[135.15, 34.2, 135.3, 34.32], [135.3, 33.9, 135.5, 34.05], [135.7, 33.65, 135.9, 33.8]] },

  tottori: { label: "鳥取県", group: "中国・四国", scaleKm: 70, hintLevel: 2,
    bboxes: [[134.15, 35.45, 134.35, 35.55], [133.3, 35.4, 133.5, 35.5], [133.95, 35.4, 134.15, 35.5]] },
  shimane: { label: "島根県", group: "中国・四国", scaleKm: 90, hintLevel: 2,
    bboxes: [[133.0, 35.42, 133.2, 35.53], [132.65, 35.15, 132.85, 35.3], [132.05, 34.85, 132.25, 35.0]] },
  okayama: { label: "岡山県", group: "中国・四国", scaleKm: 80, hintLevel: 2,
    bboxes: [[133.85, 34.6, 134.0, 34.72], [133.7, 34.55, 133.85, 34.65], [133.35, 34.45, 133.55, 34.6]] },
  hiroshima: { label: "広島県", group: "中国・四国", scaleKm: 80, hintLevel: 2,
    bboxes: [[132.4, 34.36, 132.55, 34.48], [133.3, 34.45, 133.5, 34.58], [132.55, 34.22, 132.75, 34.35]] },
  yamaguchi: { label: "山口県", group: "中国・四国", scaleKm: 80, hintLevel: 2,
    bboxes: [[131.4, 33.92, 131.6, 34.05], [131.4, 34.15, 131.6, 34.28], [130.9, 33.95, 131.1, 34.08]] },
  tokushima: { label: "徳島県", group: "中国・四国", scaleKm: 60, hintLevel: 2,
    bboxes: [[134.5, 34.03, 134.65, 34.13], [134.3, 33.9, 134.5, 34.05], [134.15, 33.85, 134.35, 34.0]] },
  kagawa: { label: "香川県", group: "中国・四国", scaleKm: 45, hintLevel: 2,
    bboxes: [[134.0, 34.3, 134.15, 34.4], [133.75, 34.25, 133.95, 34.38], [134.15, 34.15, 134.35, 34.28]] },
  ehime: { label: "愛媛県", group: "中国・四国", scaleKm: 80, hintLevel: 2,
    bboxes: [[132.7, 33.8, 132.85, 33.9], [132.95, 33.9, 133.15, 34.05], [132.5, 33.2, 132.7, 33.35]] },
  kochi: { label: "高知県", group: "中国・四国", scaleKm: 90, hintLevel: 2,
    bboxes: [[133.45, 33.52, 133.65, 33.62], [133.6, 33.6, 133.8, 33.72], [132.9, 32.95, 133.1, 33.1]] },

  fukuoka: { label: "福岡県", group: "九州・沖縄", scaleKm: 80, hintLevel: 2,
    bboxes: [[130.35, 33.55, 130.5, 33.65], [130.8, 33.85, 131.0, 33.95], [130.4, 33.3, 130.6, 33.42]] },
  saga: { label: "佐賀県", group: "九州・沖縄", scaleKm: 55, hintLevel: 2,
    bboxes: [[130.25, 33.23, 130.4, 33.35], [129.95, 33.42, 130.15, 33.55], [130.05, 33.15, 130.25, 33.28]] },
  nagasaki: { label: "長崎県", group: "九州・沖縄", scaleKm: 90, hintLevel: 2,
    bboxes: [[129.83, 32.72, 129.95, 32.82], [129.65, 33.13, 129.8, 33.25], [129.25, 34.15, 129.45, 34.35]] },
  kumamoto: { label: "熊本県", group: "九州・沖縄", scaleKm: 80, hintLevel: 2,
    bboxes: [[130.65, 32.75, 130.8, 32.85], [130.55, 32.45, 130.75, 32.58], [131.0, 32.85, 131.2, 32.98]] },
  oita: { label: "大分県", group: "九州・沖縄", scaleKm: 70, hintLevel: 2,
    bboxes: [[131.55, 33.18, 131.75, 33.3], [131.45, 33.25, 131.6, 33.38], [131.3, 33.05, 131.5, 33.18]] },
  miyazaki: { label: "宮崎県", group: "九州・沖縄", scaleKm: 80, hintLevel: 2,
    bboxes: [[131.35, 31.85, 131.5, 31.98], [131.6, 32.4, 131.75, 32.55], [131.05, 32.05, 131.25, 32.2]] },
  kagoshima: { label: "鹿児島県", group: "九州・沖縄", scaleKm: 110, hintLevel: 2,
    bboxes: [[130.5, 31.55, 130.65, 31.65], [130.3, 31.35, 130.5, 31.5], [129.45, 28.3, 129.65, 28.45]] },
  okinawa: { label: "沖縄県", group: "九州・沖縄", scaleKm: 80, hintLevel: 2,
    bboxes: [[127.65, 26.18, 127.85, 26.35], [127.85, 26.4, 128.1, 26.6], [125.25, 24.75, 125.42, 24.88]] },

  /* ---------- 海外（hintLevel:1 = 国は自明なので州・都市から） ---------- */
  c_korea: { label: "韓国", group: "アジア", scaleKm: 400, hintLevel: 1,
    bboxes: [[126.85, 37.45, 127.15, 37.65], [129.0, 35.1, 129.2, 35.25], [128.5, 35.8, 128.7, 35.95]] },
  c_taiwan: { label: "台湾", group: "アジア", scaleKm: 350, hintLevel: 1,
    bboxes: [[121.45, 25.0, 121.62, 25.12], [120.6, 24.12, 120.75, 24.22], [120.25, 22.6, 120.4, 22.72]] },
  c_thailand: { label: "タイ", group: "アジア", scaleKm: 800, hintLevel: 1,
    bboxes: [[100.45, 13.68, 100.65, 13.82], [98.95, 18.75, 99.05, 18.82]] },
  c_singapore: { label: "シンガポール", group: "アジア", scaleKm: 50, hintLevel: 1,
    bboxes: [[103.75, 1.27, 103.9, 1.37]] },
  c_usa: { label: "アメリカ", group: "北米", scaleKm: 4000, hintLevel: 1,
    bboxes: [[-74.02, 40.7, -73.93, 40.79], [-118.35, 34.02, -118.2, 34.12], [-122.45, 37.74, -122.38, 37.8],
             [-87.7, 41.85, -87.6, 41.93], [-122.36, 47.58, -122.29, 47.65], [-97.78, 30.24, -97.7, 30.31]] },
  c_canada: { label: "カナダ", group: "北米", scaleKm: 3000, hintLevel: 1,
    bboxes: [[-79.42, 43.63, -79.35, 43.7], [-123.15, 49.24, -123.06, 49.3], [-73.6, 45.48, -73.53, 45.54]] },
  c_mexico: { label: "メキシコ", group: "北米", scaleKm: 1500, hintLevel: 1,
    bboxes: [[-99.18, 19.38, -99.1, 19.45], [-103.38, 20.65, -103.3, 20.72]] },
  c_uk: { label: "イギリス", group: "ヨーロッパ", scaleKm: 700, hintLevel: 1,
    bboxes: [[-0.2, 51.48, -0.05, 51.55], [-2.28, 53.45, -2.2, 53.5], [-3.2, 55.93, -3.13, 55.97]] },
  c_france: { label: "フランス", group: "ヨーロッパ", scaleKm: 800, hintLevel: 1,
    bboxes: [[2.28, 48.83, 2.4, 48.89], [4.82, 45.74, 4.88, 45.78], [5.35, 43.28, 5.42, 43.32]] },
  c_germany: { label: "ドイツ", group: "ヨーロッパ", scaleKm: 700, hintLevel: 1,
    bboxes: [[13.35, 52.49, 13.45, 52.54], [11.54, 48.12, 11.62, 48.17], [9.98, 53.53, 10.05, 53.58]] },
  c_italy: { label: "イタリア", group: "ヨーロッパ", scaleKm: 900, hintLevel: 1,
    bboxes: [[12.45, 41.88, 12.53, 41.93], [9.16, 45.45, 9.23, 45.5], [11.24, 43.76, 11.29, 43.79]] },
  c_spain: { label: "スペイン", group: "ヨーロッパ", scaleKm: 800, hintLevel: 1,
    bboxes: [[-3.72, 40.4, -3.65, 40.45], [2.15, 41.38, 2.2, 41.42], [-5.99, 37.38, -5.97, 37.4]] },
  c_netherlands: { label: "オランダ", group: "ヨーロッパ", scaleKm: 250, hintLevel: 1,
    bboxes: [[4.86, 52.35, 4.93, 52.39], [4.45, 51.9, 4.52, 51.94]] },
  c_sweden: { label: "スウェーデン", group: "ヨーロッパ", scaleKm: 900, hintLevel: 1,
    bboxes: [[18.03, 59.31, 18.11, 59.35], [11.95, 57.69, 12.02, 57.73], [13.0, 55.58, 13.05, 55.61]] },
  c_australia: { label: "オーストラリア", group: "その他", scaleKm: 3000, hintLevel: 1,
    bboxes: [[151.18, -33.89, 151.25, -33.85], [144.94, -37.83, 145.0, -37.79], [153.0, -27.49, 153.06, -27.45]] },
  c_brazil: { label: "ブラジル", group: "その他", scaleKm: 3000, hintLevel: 1,
    bboxes: [[-46.66, -23.57, -46.6, -23.53], [-43.22, -22.93, -43.15, -22.89]] },
};

export function regionScaleKm(region: RegionKey): number {
  return REGION_DEFS[region]?.scaleKm ?? 200;
}

/** そのエリアで最初に出すヒントの粒度 */
export function regionHintLevel(region: RegionKey): 0 | 1 | 2 {
  return REGION_DEFS[region]?.hintLevel ?? 0;
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
 *  1. 360度パノラマ
 *  2. 解像度（看板・標識が読めるかを直接左右する）
 *  3. 撮影の新しさ
 *  4. 周囲150m以内の画像枚数
 *  5. 同じシーケンスの長さ
 *  6. Mapillaryの品質スコア
 */
function playabilityScore(img: RawImage, neighbors: number, seqLength: number): number {
  const pano = img.is_pano ? 4_000_000 : 0;
  const resolution = Math.min(1, (img.width ?? 1024) / 8000) * 1_500_000;
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

/** 検索が完全に失敗した場合の最終フォールバック */
export function randomFallbackPoint(region: RegionKey): LatLng {
  return randomPointInRegion(region);
}

/**
 * 指定したエリアの中からランダムな座標を選び、その近くのMapillary画像を探す。
 * 「良い条件で何度も引き直す」方式。引き直す回数を増やすほど画質は上がる。
 */
export async function findStreetPoint(
  token: string,
  region: RegionKey,
  avoidPoints: LatLng[] = []
): Promise<StreetSpot | null> {
  const scale = regionScaleKm(region);
  // 狭いエリアほど「前回と同じ場所」を避ける距離も狭くしないと、候補が尽きる
  const minSeparationKm = Math.max(0.6, Math.min(50, scale / 60));
  let lastResort: StreetSpot | null = null;

  for (let attempt = 0; attempt < 14; attempt++) {
    const center = randomPointInRegion(region);
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
  const spread = pressureKm < 5 ? 40 : 80;
  return { bearing: (away + (Math.random() * spread - spread / 2) + 360) % 360, pressureKm };
}

/**
 * 逃走者の移動先を決める。
 * pursuers には「そのラウンドで実際に送られてきた回答座標」を渡す。
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

  const jumpChance = pressureKm < 5 ? 0.55 : pressureKm < 30 ? 0.35 : 0.2;
  const shouldJump = Math.random() < jumpChance;

  if (!shouldJump) {
    const steps = pressureKm < 5 ? [4.0, 2.4, 1.2, 0.6] : [1.2, 2.4, 0.6, 4.0];
    for (const distanceKm of steps) {
      const bearing = (baseBearing + (Math.random() * 30 - 15) + 360) % 360;
      const nextPoint = destinationPoint(current, bearing, distanceKm);
      const nearby = await searchOnce(token, nextPoint, 0.03, 60);
      if (nearby.length === 0) continue;

      const ranked = rankSpots(nearby);
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
 * 任意地点の画像探索（下見・別の道へ）
 * ------------------------------------------------------------------ */

export interface NearestOptions {
  panoOnly?: boolean;
  /** この画像IDは選ばない */
  excludeId?: string;
  /** このシーケンスは選ばない（別の道へ移りたいとき） */
  excludeSequenceId?: string;
  /** これより近い画像は選ばない(km) */
  minKm?: number;
  /** 検索半径(度)の開始値 */
  startRadius?: number;
}

/** クリック地点／現在地に近い画像を返す。条件に合うものが無ければ段階的にゆるめる */
export async function nearestImage(token: string, point: LatLng, opts: NearestOptions = {}): Promise<StreetSpot | null> {
  const { panoOnly = false, excludeId, excludeSequenceId, minKm = 0, startRadius = 0.008 } = opts;
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

    const pool = panoOnly ? usable.filter((c) => c.is_pano) : usable;
    const target = pool.length > 0 ? pool : usable;

    const sorted = target
      .map((c) => ({ img: c, d: haversineKmLocal(point, coordOf(c)) }))
      .sort((a, b) => a.d - b.d);

    if (!relaxed && sorted[0]) relaxed = toSpot(sorted[0].img);

    const hit = sorted.find((s) => s.d >= minKm);
    if (hit) return toSpot(hit.img);
  }

  return relaxed;
}

/** 現在地から指定した方位・距離だけ離れた地点を球面三角法で計算する */
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
        suburb?: string;
      };
    };
    const addr = data.address ?? {};
    const place: Place = {
      country: addr.country,
      state: addr.state ?? addr.province,
      city: addr.city ?? addr.town ?? addr.village ?? addr.county ?? addr.suburb,
    };
    if (kv) {
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
 *
 * 順序は固定:
 *   国・地域 → 都道府県・州 → 市区町村 → おおよその緯度経度 → 詳しい座標
 *
 * ただし hintLevel より粗いヒントは省く。
 * たとえば「大阪府」を選んで遊んでいるなら、国と都道府県は最初から分かって
 * いるので出さず、市区町村から始める。
 */
export async function buildPlaceHints(point: LatLng, kv?: KVNamespace, hintLevel: 0 | 1 | 2 = 0): Promise<string[]> {
  const place = await reverseGeocode(point, kv);
  const hints: string[] = [];

  if (hintLevel <= 0 && place.country) hints.push(`国・地域: ${place.country}`);
  if (hintLevel <= 1 && place.state) hints.push(`都道府県・州: ${place.state}`);
  if (place.city) hints.push(`市区町村: ${place.city}`);
  hints.push(`おおよその緯度: ${Math.round(point.lat)}° / 経度: ${Math.round(point.lng)}°`);
  hints.push(`詳しい座標: ${point.lat.toFixed(2)}, ${point.lng.toFixed(2)}`);

  return hints;
}