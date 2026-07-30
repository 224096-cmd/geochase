import type { LatLng, RegionKey, StreetSpot, TransportMode } from "./types";

const GRAPH_URL = "https://graph.mapillary.com";
const IMAGES_URL = `${GRAPH_URL}/images`;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";

const FETCH_TIMEOUT_MS = 9000;
const INTERACTIVE_TIMEOUT_MS = 6000;

// bbox は面積0.01平方度未満でないとAPIが500を返す
const MAX_BBOX_AREA_DEG2 = 0.0092;

// 面積が上限内でも矩形内の画像が多すぎると500になる。都心は半径200m程度まで
// 絞る必要があり、地方は4km近くまで広げないと0枚。よって二方向のハシゴで探す
const WIDEN_LADDER_KM = [0.4, 1.7, 3.9];
const SHRINK_LADDER_KM = [0.18, 0.07];

// Workers無料プランは1リクエスト50サブリクエストまで
const SEARCH_BUDGET = 20;

const WALK_RADIUS_KM = 0.15;
const MIN_NEIGHBORS = 5;
const MIN_SEQUENCE_LENGTH = 8;

const CAR_MAX_SPEED_MPS = 45;
const CAR_MIN_SPEED_MPS = 8;
const MAX_ALTITUDE_M = 3900;
const MAX_ALTITUDE_SPREAD_M = 400;
const STRAIGHT_RUN_KM = 1.2;
const STRAIGHT_TURN_PER_KM = 8;

interface QualityTier {
  label: string;
  pano: boolean;
  minWidth: number;
  freshYears: number;
  walkable: boolean;
}

const QUALITY_TIERS: QualityTier[] = [
  { label: "pano-best", pano: true, minWidth: 5000, freshYears: 8, walkable: true },
  { label: "pano-good", pano: true, minWidth: 3800, freshYears: 12, walkable: true },
  { label: "pano-any", pano: true, minWidth: 0, freshYears: 0, walkable: false },
  { label: "flat-good", pano: false, minWidth: 2560, freshYears: 12, walkable: true },
  { label: "flat-any", pano: false, minWidth: 0, freshYears: 0, walkable: false },
];

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

type Bbox = [number, number, number, number];

type HintLevel = 0 | 1 | 2;

interface RegionDef {
  label: string;
  group: string;
  bboxes: Bbox[];
  scaleKm: number;
  hintLevel: HintLevel;
  fallback?: RegionKey;
}

export const REGION_DEFS: Record<string, RegionDef> = {
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

  r_hokkaido: { label: "北海道地方", group: "地方", scaleKm: 600, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[140.6, 42.6, 142.2, 43.6], [140.0, 41.4, 141.6, 42.6], [141.4, 43.5, 143.2, 45.5], [142.5, 42.8, 145.6, 44.4]] },
  r_tohoku: { label: "東北地方", group: "地方", scaleKm: 500, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[139.5, 40.2, 141.7, 41.6], [140.6, 38.7, 142.1, 40.5], [140.3, 37.7, 141.7, 39.0], [139.1, 36.8, 141.1, 38.0]] },
  r_kanto: { label: "関東地方", group: "地方", scaleKm: 300, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[139.0, 35.4, 140.0, 35.95], [139.6, 35.1, 140.2, 35.7], [139.7, 35.6, 140.9, 36.4], [139.2, 36.1, 140.3, 37.0]] },
  r_chubu: { label: "中部地方", group: "地方", scaleKm: 450, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[136.7, 34.9, 137.9, 35.4], [137.4, 34.6, 139.2, 35.5], [137.3, 35.5, 138.7, 36.8], [136.6, 36.4, 137.9, 37.1], [138.7, 37.3, 139.8, 38.3]] },
  r_kinki: { label: "近畿地方", group: "地方", scaleKm: 300, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[135.1, 34.3, 135.8, 34.85], [135.0, 34.6, 135.9, 35.1], [134.6, 34.6, 135.5, 35.0], [135.7, 34.9, 136.3, 35.4], [135.7, 34.4, 136.2, 34.8]] },
  r_chugoku: { label: "中国地方", group: "地方", scaleKm: 400, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[132.35, 34.35, 132.55, 34.45], [133.9, 34.63, 134.1, 34.73], [131.42, 34.15, 131.55, 34.25], [133.02, 35.43, 133.14, 35.51], [132.72, 34.37, 132.82, 34.45]] },
  r_shikoku: { label: "四国地方", group: "地方", scaleKm: 300, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[134.52, 34.04, 134.62, 34.12], [134.02, 34.3, 134.12, 34.38], [132.74, 33.81, 132.82, 33.88], [133.5, 33.53, 133.6, 33.6]] },
  r_kyushu: { label: "九州・沖縄地方", group: "地方", scaleKm: 900, hintLevel: 1, fallback: "japan_wide",
    bboxes: [[130.38, 33.56, 130.46, 33.62], [130.68, 32.78, 130.76, 32.84], [130.53, 31.56, 130.61, 31.62], [131.4, 31.89, 131.48, 31.95], [127.66, 26.19, 127.76, 26.27]] },

  hokkaido: { label: "北海道", group: "都道府県｜北海道・東北", scaleKm: 500, hintLevel: 2, fallback: "r_hokkaido",
    bboxes: [[141.3, 43.03, 141.42, 43.09], [140.7, 41.76, 140.79, 41.81], [144.35, 42.97, 144.42, 43.0], [143.19, 42.91, 143.25, 42.95]] },
  aomori: { label: "青森県", group: "都道府県｜北海道・東北", scaleKm: 120, hintLevel: 2, fallback: "r_tohoku",
    bboxes: [[140.71, 40.8, 140.79, 40.85], [141.48, 40.5, 141.56, 40.55], [140.44, 40.57, 140.51, 40.62]] },
  iwate: { label: "岩手県", group: "都道府県｜北海道・東北", scaleKm: 150, hintLevel: 2, fallback: "r_tohoku",
    bboxes: [[141.12, 39.68, 141.2, 39.73], [141.9, 39.62, 141.97, 39.67], [141.11, 39.28, 141.18, 39.33]] },
  miyagi: { label: "宮城県", group: "都道府県｜北海道・東北", scaleKm: 110, hintLevel: 2, fallback: "r_tohoku",
    bboxes: [[140.85, 38.24, 140.94, 38.29], [141.29, 38.41, 141.37, 38.46], [140.94, 38.09, 141.01, 38.14]] },
  akita: { label: "秋田県", group: "都道府県｜北海道・東北", scaleKm: 130, hintLevel: 2, fallback: "r_tohoku",
    bboxes: [[140.08, 39.69, 140.16, 39.74], [140.55, 39.42, 140.62, 39.46], [140.36, 40.2, 140.43, 40.25]] },
  yamagata: { label: "山形県", group: "都道府県｜北海道・東北", scaleKm: 110, hintLevel: 2, fallback: "r_tohoku",
    bboxes: [[140.31, 38.23, 140.39, 38.28], [139.82, 38.72, 139.9, 38.77], [140.1, 37.89, 140.17, 37.94]] },
  fukushima: { label: "福島県", group: "都道府県｜北海道・東北", scaleKm: 130, hintLevel: 2, fallback: "r_tohoku",
    bboxes: [[140.44, 37.73, 140.52, 37.78], [139.91, 37.48, 139.99, 37.53], [140.87, 37.03, 140.95, 37.08]] },

  ibaraki: { label: "茨城県", group: "都道府県｜関東", scaleKm: 90, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[140.42, 36.35, 140.5, 36.4], [140.07, 36.06, 140.15, 36.11], [140.55, 36.63, 140.63, 36.68]] },
  tochigi: { label: "栃木県", group: "都道府県｜関東", scaleKm: 90, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[139.86, 36.54, 139.94, 36.59], [139.69, 36.31, 139.77, 36.36], [139.6, 36.73, 139.68, 36.78]] },
  gunma: { label: "群馬県", group: "都道府県｜関東", scaleKm: 90, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[139.03, 36.36, 139.11, 36.41], [139.29, 36.31, 139.37, 36.36], [138.88, 36.55, 138.96, 36.6]] },
  saitama: { label: "埼玉県", group: "都道府県｜関東", scaleKm: 70, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[139.61, 35.84, 139.69, 35.89], [139.4, 35.89, 139.48, 35.94], [139.06, 35.99, 139.14, 36.04]] },
  chiba: { label: "千葉県", group: "都道府県｜関東", scaleKm: 90, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[140.08, 35.58, 140.16, 35.63], [140.11, 35.7, 140.19, 35.75], [139.9, 35.33, 139.98, 35.38]] },
  tokyo: { label: "東京都", group: "都道府県｜関東", scaleKm: 45, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[139.69, 35.66, 139.78, 35.72], [139.53, 35.68, 139.61, 35.73], [139.32, 35.69, 139.4, 35.74]] },
  kanagawa: { label: "神奈川県", group: "都道府県｜関東", scaleKm: 70, hintLevel: 2, fallback: "r_kanto",
    bboxes: [[139.6, 35.44, 139.68, 35.49], [139.62, 35.29, 139.7, 35.34], [139.34, 35.36, 139.42, 35.41]] },

  niigata: { label: "新潟県", group: "都道府県｜中部", scaleKm: 140, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[139.02, 37.89, 139.1, 37.94], [138.23, 37.44, 138.31, 37.49], [139.05, 37.53, 139.13, 37.58]] },
  toyama: { label: "富山県", group: "都道府県｜中部", scaleKm: 70, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[137.18, 36.68, 137.26, 36.73], [136.98, 36.73, 137.06, 36.78], [137.24, 36.48, 137.32, 36.53]] },
  ishikawa: { label: "石川県", group: "都道府県｜中部", scaleKm: 90, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[136.62, 36.55, 136.7, 36.6], [136.83, 36.78, 136.91, 36.83], [136.94, 37.23, 137.02, 37.28]] },
  fukui: { label: "福井県", group: "都道府県｜中部", scaleKm: 80, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[136.18, 36.03, 136.26, 36.08], [136.03, 35.63, 136.11, 35.68], [135.75, 35.47, 135.83, 35.52]] },
  yamanashi: { label: "山梨県", group: "都道府県｜中部", scaleKm: 70, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[138.54, 35.64, 138.62, 35.69], [138.44, 35.53, 138.52, 35.58], [138.75, 35.48, 138.83, 35.53]] },
  nagano: { label: "長野県", group: "都道府県｜中部", scaleKm: 130, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[138.16, 36.62, 138.24, 36.67], [137.94, 36.21, 138.02, 36.26], [138.19, 35.97, 138.27, 36.02]] },
  gifu: { label: "岐阜県", group: "都道府県｜中部", scaleKm: 100, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[136.73, 35.39, 136.81, 35.44], [136.53, 35.43, 136.61, 35.48], [137.18, 36.12, 137.26, 36.17]] },
  shizuoka: { label: "静岡県", group: "都道府県｜中部", scaleKm: 110, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[138.34, 34.96, 138.42, 35.01], [137.7, 34.68, 137.78, 34.73], [138.92, 35.09, 139.0, 35.14]] },
  aichi: { label: "愛知県", group: "都道府県｜中部", scaleKm: 80, hintLevel: 2, fallback: "r_chubu",
    bboxes: [[136.86, 35.15, 136.94, 35.2], [137.12, 34.99, 137.2, 35.04], [137.37, 34.73, 137.45, 34.78]] },

  mie: { label: "三重県", group: "都道府県｜近畿", scaleKm: 100, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[136.48, 34.7, 136.56, 34.75], [136.62, 34.47, 136.7, 34.52], [136.73, 34.47, 136.81, 34.52]] },
  shiga: { label: "滋賀県", group: "都道府県｜近畿", scaleKm: 60, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[135.87, 35.0, 135.95, 35.05], [136.24, 35.27, 136.32, 35.32], [135.98, 34.96, 136.06, 35.01]] },
  kyoto: { label: "京都府", group: "都道府県｜近畿", scaleKm: 70, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[135.73, 34.98, 135.81, 35.04], [135.62, 34.87, 135.7, 34.92], [135.24, 35.46, 135.32, 35.51]] },
  osaka: { label: "大阪府", group: "都道府県｜近畿", scaleKm: 45, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[135.47, 34.66, 135.55, 34.72], [135.55, 34.56, 135.63, 34.61], [135.58, 34.77, 135.66, 34.82]] },
  hyogo: { label: "兵庫県", group: "都道府県｜近畿", scaleKm: 100, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[135.16, 34.67, 135.24, 34.72], [134.68, 34.8, 134.76, 34.85], [134.98, 34.79, 135.06, 34.84]] },
  nara: { label: "奈良県", group: "都道府県｜近畿", scaleKm: 60, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[135.79, 34.66, 135.87, 34.71], [135.77, 34.49, 135.85, 34.54], [135.86, 34.29, 135.94, 34.34]] },
  wakayama: { label: "和歌山県", group: "都道府県｜近畿", scaleKm: 80, hintLevel: 2, fallback: "r_kinki",
    bboxes: [[135.16, 34.21, 135.24, 34.26], [135.36, 33.9, 135.44, 33.95], [135.75, 33.68, 135.83, 33.73]] },

  tottori: { label: "鳥取県", group: "都道府県｜中国・四国", scaleKm: 70, hintLevel: 2, fallback: "r_chugoku",
    bboxes: [[134.19, 35.47, 134.27, 35.52], [133.32, 35.41, 133.4, 35.46], [133.98, 35.42, 134.06, 35.47]] },
  shimane: { label: "島根県", group: "都道府県｜中国・四国", scaleKm: 90, hintLevel: 2, fallback: "r_chugoku",
    bboxes: [[133.02, 35.44, 133.1, 35.49], [132.74, 35.36, 132.82, 35.41], [132.06, 34.87, 132.14, 34.92]] },
  okayama: { label: "岡山県", group: "都道府県｜中国・四国", scaleKm: 80, hintLevel: 2, fallback: "r_chugoku",
    bboxes: [[133.89, 34.64, 133.97, 34.69], [133.74, 34.56, 133.82, 34.61], [133.42, 34.47, 133.5, 34.52]] },
  hiroshima: { label: "広島県", group: "都道府県｜中国・四国", scaleKm: 80, hintLevel: 2, fallback: "r_chugoku",
    bboxes: [[132.42, 34.37, 132.5, 34.42], [133.34, 34.47, 133.42, 34.52], [132.72, 34.38, 132.8, 34.43]] },
  yamaguchi: { label: "山口県", group: "都道府県｜中国・四国", scaleKm: 80, hintLevel: 2, fallback: "r_chugoku",
    bboxes: [[131.44, 33.94, 131.52, 33.99], [131.44, 34.16, 131.52, 34.21], [130.92, 33.96, 131.0, 34.01]] },
  tokushima: { label: "徳島県", group: "都道府県｜中国・四国", scaleKm: 60, hintLevel: 2, fallback: "r_shikoku",
    bboxes: [[134.52, 34.04, 134.6, 34.09], [134.35, 33.92, 134.43, 33.97], [134.17, 33.87, 134.25, 33.92]] },
  kagawa: { label: "香川県", group: "都道府県｜中国・四国", scaleKm: 45, hintLevel: 2, fallback: "r_shikoku",
    bboxes: [[134.02, 34.32, 134.1, 34.37], [133.78, 34.27, 133.86, 34.32], [134.17, 34.17, 134.25, 34.22]] },
  ehime: { label: "愛媛県", group: "都道府県｜中国・四国", scaleKm: 80, hintLevel: 2, fallback: "r_shikoku",
    bboxes: [[132.74, 33.82, 132.82, 33.87], [132.98, 33.92, 133.06, 33.97], [132.53, 33.22, 132.61, 33.27]] },
  kochi: { label: "高知県", group: "都道府県｜中国・四国", scaleKm: 90, hintLevel: 2, fallback: "r_shikoku",
    bboxes: [[133.5, 33.54, 133.58, 33.59], [133.63, 33.62, 133.71, 33.67], [132.93, 32.97, 133.01, 33.02]] },

  fukuoka: { label: "福岡県", group: "都道府県｜九州・沖縄", scaleKm: 80, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[130.38, 33.57, 130.46, 33.62], [130.83, 33.86, 130.91, 33.91], [130.42, 33.31, 130.5, 33.36]] },
  saga: { label: "佐賀県", group: "都道府県｜九州・沖縄", scaleKm: 55, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[130.27, 33.24, 130.35, 33.29], [129.97, 33.44, 130.05, 33.49], [130.07, 33.16, 130.15, 33.21]] },
  nagasaki: { label: "長崎県", group: "都道府県｜九州・沖縄", scaleKm: 90, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[129.84, 32.73, 129.92, 32.78], [129.67, 33.14, 129.75, 33.19], [129.28, 34.17, 129.36, 34.22]] },
  kumamoto: { label: "熊本県", group: "都道府県｜九州・沖縄", scaleKm: 80, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[130.67, 32.77, 130.75, 32.82], [130.58, 32.46, 130.66, 32.51], [131.02, 32.86, 131.1, 32.91]] },
  oita: { label: "大分県", group: "都道府県｜九州・沖縄", scaleKm: 70, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[131.58, 33.19, 131.66, 33.24], [131.47, 33.26, 131.55, 33.31], [131.33, 33.06, 131.41, 33.11]] },
  miyazaki: { label: "宮崎県", group: "都道府県｜九州・沖縄", scaleKm: 80, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[131.38, 31.89, 131.46, 31.94], [131.62, 32.41, 131.7, 32.46], [131.07, 32.06, 131.15, 32.11]] },
  kagoshima: { label: "鹿児島県", group: "都道府県｜九州・沖縄", scaleKm: 110, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[130.53, 31.56, 130.61, 31.61], [130.32, 31.36, 130.4, 31.41], [130.65, 31.72, 130.73, 31.77]] },
  okinawa: { label: "沖縄県", group: "都道府県｜九州・沖縄", scaleKm: 80, hintLevel: 2, fallback: "r_kyushu",
    bboxes: [[127.67, 26.2, 127.75, 26.25], [127.88, 26.43, 127.96, 26.48], [125.27, 24.78, 125.35, 24.83]] },

  c_korea: { label: "韓国", group: "海外｜アジア", scaleKm: 400, hintLevel: 1, fallback: "world",
    bboxes: [[126.95, 37.5, 127.05, 37.58], [129.03, 35.13, 129.11, 35.19], [128.56, 35.84, 128.64, 35.9]] },
  c_taiwan: { label: "台湾", group: "海外｜アジア", scaleKm: 350, hintLevel: 1, fallback: "world",
    bboxes: [[121.5, 25.03, 121.58, 25.08], [120.65, 24.13, 120.73, 24.18], [120.28, 22.61, 120.36, 22.66]] },
  c_thailand: { label: "タイ", group: "海外｜アジア", scaleKm: 800, hintLevel: 1, fallback: "world",
    bboxes: [[100.49, 13.72, 100.57, 13.77], [98.97, 18.77, 99.02, 18.81]] },
  c_singapore: { label: "シンガポール", group: "海外｜アジア", scaleKm: 50, hintLevel: 1, fallback: "world",
    bboxes: [[103.79, 1.29, 103.87, 1.34]] },
  c_usa: { label: "アメリカ", group: "海外｜北米", scaleKm: 4000, hintLevel: 1, fallback: "world",
    bboxes: [[-74.0, 40.72, -73.95, 40.77], [-118.3, 34.03, -118.22, 34.08], [-122.43, 37.75, -122.39, 37.79],
             [-87.68, 41.87, -87.62, 41.91], [-122.34, 47.59, -122.3, 47.63], [-97.76, 30.25, -97.72, 30.29]] },
  c_canada: { label: "カナダ", group: "海外｜北米", scaleKm: 3000, hintLevel: 1, fallback: "world",
    bboxes: [[-79.4, 43.64, -79.36, 43.68], [-123.13, 49.25, -123.09, 49.29], [-73.58, 45.49, -73.54, 45.53]] },
  c_mexico: { label: "メキシコ", group: "海外｜北米", scaleKm: 1500, hintLevel: 1, fallback: "world",
    bboxes: [[-99.16, 19.39, -99.12, 19.44], [-103.36, 20.66, -103.32, 20.7]] },
  c_uk: { label: "イギリス", group: "海外｜ヨーロッパ", scaleKm: 700, hintLevel: 1, fallback: "world",
    bboxes: [[-0.15, 51.49, -0.08, 51.53], [-2.26, 53.46, -2.22, 53.49], [-3.19, 55.94, -3.15, 55.96]] },
  c_france: { label: "フランス", group: "海外｜ヨーロッパ", scaleKm: 800, hintLevel: 1, fallback: "world",
    bboxes: [[2.3, 48.84, 2.38, 48.88], [4.83, 45.75, 4.87, 45.77], [5.36, 43.29, 5.4, 43.31]] },
  c_germany: { label: "ドイツ", group: "海外｜ヨーロッパ", scaleKm: 700, hintLevel: 1, fallback: "world",
    bboxes: [[13.37, 52.5, 13.43, 52.53], [11.55, 48.13, 11.6, 48.16], [9.99, 53.54, 10.03, 53.57]] },
  c_italy: { label: "イタリア", group: "海外｜ヨーロッパ", scaleKm: 900, hintLevel: 1, fallback: "world",
    bboxes: [[12.46, 41.89, 12.52, 41.92], [9.17, 45.46, 9.21, 45.49], [11.24, 43.77, 11.28, 43.79]] },
  c_spain: { label: "スペイン", group: "海外｜ヨーロッパ", scaleKm: 800, hintLevel: 1, fallback: "world",
    bboxes: [[-3.71, 40.41, -3.67, 40.44], [2.16, 41.38, 2.2, 41.41], [-5.99, 37.38, -5.97, 37.4]] },
  c_netherlands: { label: "オランダ", group: "海外｜ヨーロッパ", scaleKm: 250, hintLevel: 1, fallback: "world",
    bboxes: [[4.88, 52.36, 4.92, 52.38], [4.46, 51.91, 4.5, 51.93]] },
  c_sweden: { label: "スウェーデン", group: "海外｜ヨーロッパ", scaleKm: 900, hintLevel: 1, fallback: "world",
    bboxes: [[18.05, 59.32, 18.09, 59.34], [11.96, 57.7, 12.0, 57.72], [13.0, 55.59, 13.04, 55.61]] },
  c_australia: { label: "オーストラリア", group: "海外｜その他", scaleKm: 3000, hintLevel: 1, fallback: "world",
    bboxes: [[151.2, -33.88, 151.24, -33.86], [144.95, -37.82, 144.99, -37.8], [153.01, -27.48, 153.05, -27.46]] },
  c_brazil: { label: "ブラジル", group: "海外｜その他", scaleKm: 3000, hintLevel: 1, fallback: "world",
    bboxes: [[-46.65, -23.56, -46.61, -23.54], [-43.21, -22.92, -43.17, -22.9]] },
};

export function regionScaleKm(region: RegionKey): number {
  return REGION_DEFS[region]?.scaleKm ?? 200;
}

export function regionHintLevel(region: RegionKey): HintLevel {
  return REGION_DEFS[region]?.hintLevel ?? 0;
}

export function regionLabel(region: RegionKey): string {
  return REGION_DEFS[region]?.label ?? region;
}

export function regionFallback(region: RegionKey): RegionKey | null {
  return REGION_DEFS[region]?.fallback ?? null;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    console.error("fetch failed", url.split("?")[0], err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

export function bearingDeg(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

function buildBboxParam(center: LatLng, halfKm: number): string {
  const latHalf = halfKm / 111.32;
  const cos = Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  let lngHalf = latHalf / cos;

  const area = 2 * latHalf * 2 * lngHalf;
  if (area > MAX_BBOX_AREA_DEG2) {
    const k = Math.sqrt(MAX_BBOX_AREA_DEG2 / area);
    return [
      center.lng - lngHalf * k,
      center.lat - latHalf * k,
      center.lng + lngHalf * k,
      center.lat + latHalf * k,
    ]
      .map((v) => v.toFixed(6))
      .join(",");
  }

  return [center.lng - lngHalf, center.lat - latHalf, center.lng + lngHalf, center.lat + latHalf]
    .map((v) => v.toFixed(6))
    .join(",");
}

export class SearchBudget {
  private used = 0;
  constructor(private readonly max: number = SEARCH_BUDGET) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used += 1;
    return true;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}

interface RawImage {
  id: string;
  geometry?: { coordinates: [number, number] };
  computed_geometry?: { coordinates: [number, number] };
  thumb_original_url?: string;
  thumb_2048_url?: string;
  thumb_1024_url?: string;
  is_pano?: boolean;
  captured_at?: number;
  width?: number;
  height?: number;
  quality_score?: number;
  sequence?: string;
  altitude?: number;
  computed_altitude?: number;
  camera_type?: string;
  make?: string;
  model?: string;
  on_foot?: boolean | null;
  compass_angle?: number;
  computed_compass_angle?: number;
}

// 一覧でフィールドを増やすとサーバー側の走査量が増え、狭い矩形でも500になる
const LIST_FIELDS = "id,geometry,computed_geometry,is_pano,captured_at,sequence";

const DETAIL_FIELDS =
  "id,geometry,computed_geometry,is_pano,captured_at,sequence,width,height,camera_type,make,model," +
  "on_foot,altitude,computed_altitude,quality_score,compass_angle,computed_compass_angle," +
  "thumb_original_url,thumb_2048_url,thumb_1024_url";

type SearchStatus = "ok" | "empty" | "dense" | "failed";

interface SearchResult {
  status: SearchStatus;
  images: RawImage[];
}

function hasCoords(img: RawImage): boolean {
  return Boolean(img?.geometry?.coordinates || img?.computed_geometry?.coordinates);
}

function coordOf(img: RawImage): LatLng {
  const [lng, lat] = (img.computed_geometry?.coordinates ?? img.geometry?.coordinates) as [number, number];
  return { lat, lng };
}

async function searchImages(
  token: string,
  center: LatLng,
  halfKm: number,
  budget: SearchBudget,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<SearchResult> {
  if (!token) {
    console.error("MAPILLARY_TOKEN is not configured");
    return { status: "failed", images: [] };
  }
  if (!budget.take()) return { status: "failed", images: [] };

  const params = new URLSearchParams({
    access_token: token,
    fields: LIST_FIELDS,
    bbox: buildBboxParam(center, halfKm),
    limit: "2000",
  });

  const res = await fetchWithTimeout(`${IMAGES_URL}?${params.toString()}`, undefined, timeoutMs);
  if (!res) return { status: "dense", images: [] };

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const dense =
      res.status >= 500 ||
      body.includes("reduce the amount of data") ||
      body.includes("Bounding box area is too large");
    if (!dense) console.error("Mapillary API error", res.status, body);
    return { status: dense ? "dense" : "failed", images: [] };
  }

  try {
    const data = (await res.json()) as { data?: RawImage[] };
    const images = (data.data ?? []).filter(hasCoords);
    return { status: images.length > 0 ? "ok" : "empty", images };
  } catch (err) {
    console.error("Mapillary JSON parse failed", err);
    return { status: "failed", images: [] };
  }
}

interface AdaptiveOptions {
  widen?: number[];
  shrink?: number[];
  timeoutMs?: number;
}

async function searchAdaptive(
  token: string,
  center: LatLng,
  budget: SearchBudget,
  opts: AdaptiveOptions = {}
): Promise<RawImage[]> {
  const widen = opts.widen ?? WIDEN_LADDER_KM;
  const shrink = opts.shrink ?? SHRINK_LADDER_KM;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  for (const halfKm of widen) {
    const result = await searchImages(token, center, halfKm, budget, timeoutMs);

    if (result.status === "ok") return result.images;
    if (result.status === "failed") return [];

    if (result.status === "dense") {
      for (const smallKm of shrink) {
        const small = await searchImages(token, center, smallKm, budget, timeoutMs);
        if (small.status === "ok") return small.images;
        if (small.status !== "dense") break;
      }
      return [];
    }
  }
  return [];
}

async function searchRadius(
  token: string,
  point: LatLng,
  radiusM: number,
  budget: SearchBudget,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<RawImage[]> {
  if (!token || !budget.take()) return [];
  const params = new URLSearchParams({
    access_token: token,
    fields: LIST_FIELDS,
    lat: String(point.lat),
    lng: String(point.lng),
    radius: String(Math.max(1, Math.min(50, Math.round(radiusM)))),
    limit: "100",
  });
  const res = await fetchWithTimeout(`${IMAGES_URL}?${params.toString()}`, undefined, timeoutMs);
  if (!res || !res.ok) return [];
  try {
    const data = (await res.json()) as { data?: RawImage[] };
    return (data.data ?? []).filter(hasCoords);
  } catch {
    return [];
  }
}

async function fetchDetails(token: string, ids: string[], budget: SearchBudget): Promise<Map<string, RawImage>> {
  const out = new Map<string, RawImage>();
  const wanted = ids.slice(0, 12);
  if (!token || wanted.length === 0 || !budget.take()) return out;

  const params = new URLSearchParams({
    access_token: token,
    ids: wanted.join(","),
    fields: DETAIL_FIELDS,
  });
  const res = await fetchWithTimeout(`${GRAPH_URL}?${params.toString()}`);
  if (!res || !res.ok) return out;

  try {
    const data = (await res.json()) as Record<string, RawImage>;
    for (const [id, img] of Object.entries(data)) {
      if (img && typeof img === "object" && hasCoords(img)) out.set(id, { ...img, id });
    }
  } catch (err) {
    console.error("Mapillary detail parse failed", err);
  }
  return out;
}

interface SeqStats {
  count: number;
  spanKm: number;
  medianSpeed: number | null;
  p80Speed: number | null;
  p95Speed: number | null;
  minSpeed: number | null;
  turnPerKm: number | null;
}

function analyseSequences(pool: RawImage[]): Map<string, SeqStats> {
  const grouped = new Map<string, RawImage[]>();
  for (const img of pool) {
    const key = img.sequence;
    if (!key || !img.captured_at) continue;
    const list = grouped.get(key);
    if (list) list.push(img);
    else grouped.set(key, [img]);
  }

  const stats = new Map<string, SeqStats>();
  for (const [key, items] of grouped) {
    items.sort((a, b) => (a.captured_at ?? 0) - (b.captured_at ?? 0));

    const speeds: number[] = [];
    let spanKm = 0;
    let turnSum = 0;
    let previousBearing: number | null = null;

    for (let i = 1; i < items.length; i++) {
      const a = coordOf(items[i - 1]);
      const b = coordOf(items[i]);
      const km = haversineKmLocal(a, b);
      const dtSec = Math.abs((items[i].captured_at ?? 0) - (items[i - 1].captured_at ?? 0)) / 1000;

      if (dtSec >= 0.3 && dtSec <= 20) speeds.push((km * 1000) / dtSec);
      if (km > 0.0005) {
        spanKm += km;
        const bearing = bearingDeg(a, b);
        if (previousBearing !== null) turnSum += angleDiff(bearing, previousBearing);
        previousBearing = bearing;
      }
    }

    speeds.sort((x, y) => x - y);
    stats.set(key, {
      count: items.length,
      spanKm,
      medianSpeed: percentile(speeds, 0.5),
      p80Speed: percentile(speeds, 0.8),
      p95Speed: percentile(speeds, 0.95),
      minSpeed: speeds.length > 0 ? speeds[0] : null,
      turnPerKm: spanKm > 0.05 ? turnSum / spanKm : null,
    });
  }
  return stats;
}

function altitudeOf(img: RawImage): number | null {
  const a = img.computed_altitude ?? img.altitude;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
}

// 徒歩1.4 / 自転車4〜7 / 自動車8〜40 / 在来線15〜30 / 新幹線70 / 飛行機200 (m/s)
// 鉄道と船は長距離を無停車でほぼ直進する。道路は交差点とカーブで必ず変化が出る
function classifyTransport(stats: SeqStats | undefined, img?: RawImage): TransportMode {
  if (img?.on_foot === true) return "foot";

  const alt = img ? altitudeOf(img) : null;
  if (alt !== null && alt > MAX_ALTITUDE_M) return "air";

  if (!stats || stats.count < 4 || stats.p80Speed === null) return "unknown";

  const { p80Speed, medianSpeed, p95Speed, minSpeed, spanKm, turnPerKm } = stats;

  if ((p95Speed ?? 0) > CAR_MAX_SPEED_MPS * 1.4) return "air";
  if (p80Speed < 3) return "foot";
  if (p80Speed < CAR_MIN_SPEED_MPS) return "cycle";
  if ((medianSpeed ?? 0) > CAR_MAX_SPEED_MPS) return "air";

  const neverSlowed = (minSpeed ?? 0) > 6;
  if (spanKm > STRAIGHT_RUN_KM && turnPerKm !== null && turnPerKm < STRAIGHT_TURN_PER_KM && neverSlowed) {
    return "rail_or_boat";
  }

  return "car";
}

function ageYears(img: RawImage): number {
  if (!img.captured_at) return 99;
  return (Date.now() - img.captured_at) / YEAR_MS;
}

interface Candidate {
  img: RawImage;
  neighbors: number;
  seqLength: number;
  ageYears: number;
  transport: TransportMode;
  score: number;
}

function rankCandidates(pool: RawImage[]): Candidate[] {
  if (pool.length === 0) return [];

  const stats = analyseSequences(pool);
  const shuffled = shuffle(pool);
  const points = shuffled.map(coordOf);

  const out: Candidate[] = [];
  for (let i = 0; i < shuffled.length; i++) {
    const img = shuffled[i];
    const seqStats = img.sequence ? stats.get(img.sequence) : undefined;
    const transport = classifyTransport(seqStats, img);
    if (transport !== "car") continue;

    let neighbors = 0;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      if (haversineKmLocal(points[i], points[j]) <= WALK_RADIUS_KM) neighbors++;
    }

    const seqLength = seqStats?.count ?? 1;
    const age = ageYears(img);
    const score =
      (img.is_pano ? 4_000_000 : 0) +
      Math.max(0, 1 - age / 10) * 900_000 +
      Math.min(neighbors, 30) * 20_000 +
      Math.min(seqLength, 40) * 13_000;

    out.push({ img, neighbors, seqLength, ageYears: age, transport, score });
  }

  return out.sort((a, b) => b.score - a.score);
}

function diversify(candidates: Candidate[], limit: number): Candidate[] {
  const seen = new Set<string>();
  const picked: Candidate[] = [];
  for (const c of candidates) {
    const key = c.img.sequence ?? c.img.id;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  for (const c of candidates) {
    if (picked.length >= limit) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

function toSpot(img: RawImage, extra: Partial<StreetSpot> = {}): StreetSpot {
  return {
    point: coordOf(img),
    imageUrl: img.thumb_original_url ?? img.thumb_2048_url ?? img.thumb_1024_url ?? "",
    imageId: img.id,
    isPano: Boolean(img.is_pano),
    sequenceId: img.sequence,
    width: img.width,
    capturedAt: img.captured_at,
    cameraType: img.camera_type,
    compassAngle: img.computed_compass_angle ?? img.compass_angle,
    qualityScore: img.quality_score ?? undefined,
    ...extra,
  };
}

function meetsTier(spot: StreetSpot, age: number, neighbors: number, seqLength: number, tier: QualityTier): boolean {
  if (tier.pano && !spot.isPano) return false;
  if (tier.minWidth > 0 && (spot.width ?? 0) < tier.minWidth) return false;
  if (tier.freshYears > 0 && age > tier.freshYears) return false;
  if (tier.walkable && (neighbors < MIN_NEIGHBORS || seqLength < MIN_SEQUENCE_LENGTH)) return false;
  return true;
}

async function selectBestSpot(
  token: string,
  candidates: Candidate[],
  budget: SearchBudget,
  accept: (spot: StreetSpot) => boolean = () => true
): Promise<StreetSpot | null> {
  const shortlist = diversify(candidates, 12);
  if (shortlist.length === 0) return null;

  const details = await fetchDetails(
    token,
    shortlist.map((c) => c.img.id),
    budget
  );

  const enriched = shortlist
    .map((c) => {
      const detail = details.get(c.img.id);
      const merged: RawImage = detail ? { ...c.img, ...detail } : c.img;
      return { ...c, img: merged };
    })
    .filter((c) => classifyTransport(undefined, c.img) !== "foot" && c.img.on_foot !== true);

  if (enriched.length === 0) return null;

  for (const tier of QUALITY_TIERS) {
    for (const c of enriched) {
      const spot = toSpot(c.img, { neighbors: c.neighbors, transport: "car" });
      if (!spot.imageId) continue;
      if (!meetsTier(spot, c.ageYears, c.neighbors, c.seqLength, tier)) continue;
      if (!accept(spot)) continue;
      return spot;
    }
  }

  const fallback = enriched.find((c) => accept(toSpot(c.img)));
  return fallback ? toSpot(fallback.img, { neighbors: fallback.neighbors, transport: "car" }) : null;
}

interface Seed {
  id: string;
  lat: number;
  lng: number;
}

const SEED_LIMIT = 80;
const SEED_TTL_SEC = 60 * 60 * 24 * 60;

function seedKey(region: RegionKey): string {
  return `seeds:v2:${region}`;
}

async function loadSeeds(kv: KVNamespace | undefined, region: RegionKey): Promise<Seed[]> {
  if (!kv) return [];
  try {
    return (await kv.get<Seed[]>(seedKey(region), "json")) ?? [];
  } catch {
    return [];
  }
}

// サムネイルURLには期限があるのでIDだけ保存し、使うときに取り直す
async function rememberSeed(kv: KVNamespace | undefined, region: RegionKey, spot: StreetSpot): Promise<void> {
  if (!kv || !spot.imageId) return;
  try {
    const seeds = await loadSeeds(kv, region);
    if (seeds.some((s) => s.id === spot.imageId)) return;
    const next = [{ id: spot.imageId, lat: spot.point.lat, lng: spot.point.lng }, ...seeds].slice(0, SEED_LIMIT);
    await kv.put(seedKey(region), JSON.stringify(next), { expirationTtl: SEED_TTL_SEC });
  } catch (err) {
    console.error("seed cache write failed", err);
  }
}

async function spotFromSeeds(
  token: string,
  kv: KVNamespace | undefined,
  region: RegionKey,
  budget: SearchBudget,
  avoidPoints: LatLng[],
  minSeparationKm: number
): Promise<StreetSpot | null> {
  const seeds = shuffle(await loadSeeds(kv, region));
  if (seeds.length === 0) return null;

  const usable = seeds.filter(
    (s) => !avoidPoints.some((p) => haversineKmLocal(p, { lat: s.lat, lng: s.lng }) < minSeparationKm)
  );
  const pick = (usable.length > 0 ? usable : seeds).slice(0, 8);
  if (pick.length === 0) return null;

  const details = await fetchDetails(token, pick.map((s) => s.id), budget);
  for (const seed of pick) {
    const img = details.get(seed.id);
    if (img && img.on_foot !== true) return toSpot(img, { transport: "car" });
  }
  return null;
}

export function randomFallbackPoint(region: RegionKey): LatLng {
  return randomPointInRegion(region);
}

export interface FoundSpot {
  spot: StreetSpot;
  region: RegionKey;
}

async function findInRegion(
  token: string,
  region: RegionKey,
  kv: KVNamespace | undefined,
  avoidPoints: LatLng[],
  budget: SearchBudget,
  attempts: number
): Promise<StreetSpot | null> {
  const scale = regionScaleKm(region);
  const minSeparationKm = Math.max(0.3, Math.min(50, scale / 60));
  const notTooClose = (spot: StreetSpot) =>
    !avoidPoints.some((p) => haversineKmLocal(p, spot.point) < minSeparationKm);

  for (let i = 0; i < attempts; i++) {
    if (budget.remaining <= 2) break;
    const center = randomPointInRegion(region);
    const pool = await searchAdaptive(token, center, budget);
    if (pool.length === 0) continue;

    const candidates = rankCandidates(pool);
    if (candidates.length === 0) continue;

    const spot = await selectBestSpot(token, candidates, budget, notTooClose);
    if (spot) {
      await rememberSeed(kv, region, spot);
      return spot;
    }
  }

  return spotFromSeeds(token, kv, region, budget, avoidPoints, minSeparationKm);
}

// 選んだエリアで見つからなければ1段広いエリアへ逃がす
export async function findStreetPointOnLand(
  token: string,
  region: RegionKey,
  kv?: KVNamespace,
  avoidPoints: LatLng[] = [],
  budget: SearchBudget = new SearchBudget()
): Promise<FoundSpot | null> {
  const chain: RegionKey[] = [region];
  const next = regionFallback(region);
  if (next && next !== region) chain.push(next);
  if (next) {
    const second = regionFallback(next);
    if (second && !chain.includes(second)) chain.push(second);
  }

  for (let i = 0; i < chain.length; i++) {
    const key = chain[i];
    const spot = await findInRegion(token, key, kv, avoidPoints, budget, i === 0 ? 5 : 3);
    if (spot) return { spot, region: key };
    if (budget.remaining <= 2) break;
  }
  return null;
}

export async function findStreetPoint(
  token: string,
  region: RegionKey,
  avoidPoints: LatLng[] = []
): Promise<StreetSpot | null> {
  const found = await findStreetPointOnLand(token, region, undefined, avoidPoints);
  return found?.spot ?? null;
}

function escapeBearing(
  current: LatLng,
  pursuers: LatLng[],
  lastBearing: number | null
): { bearing: number; pressureKm: number } {
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

  const away = bearingDeg(nearest, current);
  const spread = pressureKm < 5 ? 40 : 80;
  return { bearing: (away + (Math.random() * spread - spread / 2) + 360) % 360, pressureKm };
}

export async function moveAI(
  token: string,
  region: RegionKey,
  current: LatLng,
  avoidPoints: LatLng[],
  lastBearing: number | null,
  pursuers: LatLng[] = [],
  kv?: KVNamespace
): Promise<(FoundSpot & { bearing: number }) | null> {
  const budget = new SearchBudget();
  const { bearing: baseBearing, pressureKm } = escapeBearing(current, pursuers, lastBearing);
  const scale = regionScaleKm(region);

  const jumpChance = pressureKm < 5 ? 0.55 : pressureKm < 30 ? 0.35 : 0.2;
  const shouldJump = Math.random() < jumpChance;

  if (!shouldJump) {
    const unit = Math.max(0.25, Math.min(1, scale / 100));
    const base = pressureKm < 5 ? [4.0, 2.4, 1.2] : [1.2, 2.4, 4.0];
    const steps = base.map((d) => d * unit);

    for (const distanceKm of steps) {
      if (budget.remaining <= 4) break;
      const bearing = (baseBearing + (Math.random() * 30 - 15) + 360) % 360;
      const nextPoint = destinationPoint(current, bearing, distanceKm);
      const pool = await searchAdaptive(token, nextPoint, budget);
      if (pool.length === 0) continue;

      const candidates = rankCandidates(pool);
      if (candidates.length === 0) continue;

      const spot = await selectBestSpot(token, candidates, budget);
      if (spot) {
        await rememberSeed(kv, region, spot);
        return { spot, region, bearing: bearingDeg(current, spot.point) };
      }
    }
  }

  const jumped = await findStreetPointOnLand(token, region, kv, avoidPoints, budget);
  if (!jumped) return null;
  return { ...jumped, bearing: bearingDeg(current, jumped.spot.point) };
}

export interface NearestOptions {
  panoOnly?: boolean;
  carOnly?: boolean;
  excludeId?: string;
  excludeSequenceId?: string;
  minKm?: number;
}

export async function nearestImage(
  token: string,
  point: LatLng,
  opts: NearestOptions = {}
): Promise<StreetSpot | null> {
  const { panoOnly = false, carOnly = true, excludeId, excludeSequenceId, minKm = 0 } = opts;
  const budget = new SearchBudget(8);

  const pools: RawImage[][] = [];

  const radiusPool = await searchRadius(token, point, 50, budget, INTERACTIVE_TIMEOUT_MS);
  if (radiusPool.length > 0) pools.push(radiusPool);

  // 小さい矩形から始める。いきなり広く取ると市街地では応答が返ってこない
  const adaptive = await searchAdaptive(token, point, budget, {
    widen: [0.08, 0.35, 1.4, 3.0],
    shrink: [0.04],
    timeoutMs: INTERACTIVE_TIMEOUT_MS,
  });
  if (adaptive.length > 0) pools.push(adaptive);

  const pool = ([] as RawImage[]).concat(...pools);
  if (pool.length === 0) return null;

  const unique = new Map<string, RawImage>();
  for (const img of pool) unique.set(img.id, img);

  const stats = analyseSequences([...unique.values()]);
  const base = [...unique.values()].filter((img) => {
    if (excludeId && img.id === excludeId) return false;
    if (excludeSequenceId && img.sequence && img.sequence === excludeSequenceId) return false;
    return true;
  });
  const farEnough = base.filter((img) => haversineKmLocal(point, coordOf(img)) >= minKm);
  let usable = farEnough.length > 0 ? farEnough : base;

  if (carOnly) {
    const cars = usable.filter(
      (img) => classifyTransport(img.sequence ? stats.get(img.sequence) : undefined, img) === "car"
    );
    if (cars.length > 0) usable = cars;
    else
      usable = usable.filter(
        (img) => classifyTransport(img.sequence ? stats.get(img.sequence) : undefined, img) === "unknown"
      );
  }
  if (usable.length === 0) return null;

  const panoPool = panoOnly ? usable.filter((img) => img.is_pano) : usable;
  const target = panoPool.length > 0 ? panoPool : usable;

  const sorted = target
    .map((img) => ({
      img,
      d: haversineKmLocal(point, coordOf(img)) * (img.is_pano ? 0.6 : 1),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);

  const details = await fetchDetails(token, sorted.map((s) => s.img.id), budget);

  const merge = (s: { img: RawImage }) => {
    const detail = details.get(s.img.id);
    return detail ? { ...s.img, ...detail } : s.img;
  };

  for (const strict of [true, false]) {
    for (const s of sorted) {
      const merged = merge(s);
      if (merged.on_foot === true) continue;
      if (panoOnly && !merged.is_pano) continue;
      const transport = classifyTransport(merged.sequence ? stats.get(merged.sequence) : undefined, merged);
      if (strict && carOnly && transport !== "car" && transport !== "unknown") continue;
      return toSpot(merged, { transport });
    }
  }

  const lastResort =
    sorted.find((s) => details.get(s.img.id)?.on_foot !== true) ?? sorted[0];
  if (!lastResort) return null;
  const img = details.get(lastResort.img.id) ?? lastResort.img;
  return toSpot(img, {
    transport: classifyTransport(img.sequence ? stats.get(img.sequence) : undefined, img),
  });
}

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

export const nextRoadPoint = destinationPoint;

interface Place {
  country?: string;
  state?: string;
  city?: string;
}

// Nominatimは1リクエスト/秒・User-Agent必須が規約。約1km四方に丸めて30日キャッシュする
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

export async function buildPlaceHints(point: LatLng, kv?: KVNamespace, hintLevel: HintLevel = 0): Promise<string[]> {
  const place = await reverseGeocode(point, kv);
  const hints: string[] = [];

  if (hintLevel <= 0 && place.country) hints.push(`国・地域: ${place.country}`);
  if (hintLevel <= 1 && place.state) hints.push(`都道府県・州: ${place.state}`);
  if (place.city) hints.push(`市区町村: ${place.city}`);
  hints.push(`おおよその緯度: ${Math.round(point.lat)}° / 経度: ${Math.round(point.lng)}°`);
  hints.push(`詳しい座標: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`);

  return hints;
}