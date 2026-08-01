/**
 * 地図・ストリート画像の出典一覧。
 * OSM(ODbL)・Mapillary(CC BY-SA)などはクレジット表記が利用条件のため、
 * 画面上からは消しても、ここから「記録」タブに常設して到達できるようにする。
 */
export const CREDITS: string[] = [
  "地図: © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
  "ストリート画像: © Mapillary contributors（CC BY-SA 4.0）",
  "地名検索: © OpenStreetMap contributors / Nominatim（ODbL）",
  "航空写真・地名: 国土地理院「地理院タイル」（写真・標準地図・淡色地図）",
  "写真 ズーム9〜13: データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）",
  "写真 ズーム2〜8: Images on 世界衛星モザイク画像 obtained from site https://lpdaac.usgs.gov/data_access maintained by the NASA Land Processes Distributed Active Archive Center (LP DAAC), USGS/Earth Resources Observation and Science (EROS) Center, Sioux Falls, South Dakota. Source of image data product.",
  "一部にGRUS画像（© Axelspace）を含みます。",
];

const WORLD_ATTRIBUTION = (import.meta.env.VITE_WORLD_ATTRIBUTION as string | undefined) ?? "";

/** 環境変数で世界写真タイルを足している場合はその出典も含めて返す */
export function getCredits(): string[] {
  return WORLD_ATTRIBUTION ? [...CREDITS, `世界範囲の写真: ${WORLD_ATTRIBUTION}`] : CREDITS;
}
