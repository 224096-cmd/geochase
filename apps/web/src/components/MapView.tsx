import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { LatLng, TrailPoint } from "../lib/types";

function makePinIcon(color: string) {
  return L.divIcon({
    className: "geo-pin",
    html: `<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${color}"/>
      <circle cx="15" cy="15" r="6" fill="#08110E"/>
    </svg>`,
    iconSize: [30, 42],
    iconAnchor: [15, 42],
  });
}

const guessPinIcon = makePinIcon("#E0483E");
const targetPinIcon = makePinIcon("#4FD1A5");

/* ==========================================================================
   地図タイル — 完全無料・商用利用可・APIキー不要のものだけで構成する

   ■ なぜ OpenStreetMap の公式タイルをやめたか
     tile.openstreetmap.org は寄付で運営されており、利用ポリシーで
     「アプリを配布するような重い利用は事前許可なしには禁止」と明記されている。
     予告なくブロックされる可能性があり、公開ゲームの常用先には不適切だった。

   ■ 地理院タイルを採用した理由
     ・完全無料。APIキーもアカウント登録も不要
     ・商用利用可（国土地理院コンテンツ利用規約。出典明示のみで申請不要）
     ・写真はオルソ化した航空写真の合成なので雲がほぼ写らない
     ・日本国内はズーム18まで（建物の形や駐車場の白線まで見える）

   ■ 制約
     高ズーム（z9以上）は日本国内のみ。「世界」で遊ぶときに効いてくる。
     VITE_WORLD_* を設定すると、その範囲を任意のタイルで埋められる。
   ========================================================================== */

const GSI_LIST_URL = "https://maps.gsi.go.jp/development/ichiran.html";
const GSI_PALE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const GSI_PHOTO_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";

/** 404時に赤いバツ画像を出さないための透明1pxタイル */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * 世界の高ズームを埋めたい場合だけ .env に設定する（任意）。
 * 未設定でもゲームは動く（日本国内はすべて地理院タイルでまかなえる）。
 */
const WORLD_MAP_URL = import.meta.env.VITE_WORLD_MAP_URL as string | undefined;
const WORLD_PHOTO_URL = import.meta.env.VITE_WORLD_PHOTO_URL as string | undefined;
const WORLD_ATTRIBUTION = (import.meta.env.VITE_WORLD_ATTRIBUTION as string | undefined) ?? "";
const WORLD_TILE_SIZE = Number(import.meta.env.VITE_WORLD_TILE_SIZE ?? 256) || 256;

/** 地理院タイルの出所明示。低ズーム側は他機関のデータを含むため全文を出せるようにする */
const GSI_CREDITS = [
  "出典: 国土地理院「地理院タイル」（淡色地図・写真）",
  "写真 ズーム9〜13（全国ランドサットモザイク画像）: データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）",
  "写真 ズーム2〜8（世界衛星モザイク画像）: Images on 世界衛星モザイク画像 obtained from site https://lpdaac.usgs.gov/data_access maintained by the NASA Land Processes Distributed Active Archive Center (LP DAAC), USGS/Earth Resources Observation and Science (EROS) Center, Sioux Falls, South Dakota. Source of image data product.",
  "淡色地図 ズーム2〜8: Shoreline data is derived from: United States. National Imagery and Mapping Agency. \"Vector Map Level 0 (VMAP0).\" Bethesda, MD: Denver, CO: The Agency; USGS Information Services, 1997.",
  "一部にGRUS画像（© Axelspace）を含みます。",
];

/** 地理院タイルが高ズームに対応している範囲（日本とその周辺） */
const JAPAN = { minLat: 20.0, maxLat: 46.5, minLng: 122.0, maxLng: 154.0 };

function insideJapan(lat: number, lng: number) {
  return lat >= JAPAN.minLat && lat <= JAPAN.maxLat && lng >= JAPAN.minLng && lng <= JAPAN.maxLng;
}

type LayerKey = "map" | "photo";

/**
 * ベースレイヤーを組み立てる。
 * 世界タイルを設定してある場合は下敷きにし、その上に地理院タイルを重ねる。
 * 地理院タイルは日本国外で404になるので、そこだけ下の世界タイルが透けて見える。
 */
function buildBaseLayer(kind: LayerKey, onLoading: (v: boolean) => void): L.LayerGroup {
  const group = L.layerGroup();
  const worldUrl = kind === "map" ? WORLD_MAP_URL : WORLD_PHOTO_URL;

  if (worldUrl) {
    const world = L.tileLayer(worldUrl, {
      attribution: WORLD_ATTRIBUTION,
      maxZoom: 19,
      maxNativeZoom: 19,
      tileSize: WORLD_TILE_SIZE,
      zoomOffset: WORLD_TILE_SIZE === 512 ? -1 : 0,
      errorTileUrl: BLANK_TILE,
      zIndex: 1,
    });
    world.on("loading", () => onLoading(true));
    world.on("load", () => onLoading(false));
    world.addTo(group);
  }

  const gsi = L.tileLayer(kind === "map" ? GSI_PALE_URL : GSI_PHOTO_URL, {
    attribution: `<a href="${GSI_LIST_URL}" target="_blank" rel="noreferrer">地理院タイル</a>（${
      kind === "map" ? "淡色地図" : "写真"
    }）`,
    maxZoom: 19,
    maxNativeZoom: 18,
    // 世界タイルがあるときは、地理院の粗い世界モザイクで上書きしない
    minZoom: worldUrl ? 9 : 2,
    errorTileUrl: BLANK_TILE,
    zIndex: 2,
  });
  gsi.on("loading", () => onLoading(true));
  gsi.on("load", () => onLoading(false));
  gsi.addTo(group);

  return group;
}

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: LatLng | null;
  targetPosition?: LatLng | null;
  /** 決着済みラウンドで逃走者がいた場所 */
  trail?: TrailPoint[];
  /** 回答受付中でないときはピンを動かせないようにする */
  locked?: boolean;
  /** 小窓表示中。操作系をすべて隠す */
  compact?: boolean;
  /** ピン地点の下見。押せないときは undefined */
  onExplore?: () => void;
  exploreLoading?: boolean;
}

export default function MapView({
  onPick,
  markerPosition,
  targetPosition,
  trail = [],
  locked = false,
  compact = false,
  onExplore,
  exploreLoading = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const guessMarker = useRef<L.Marker | null>(null);
  const targetMarker = useRef<L.Marker | null>(null);
  const resultLine = useRef<L.Polyline | null>(null);
  const trailLayer = useRef<L.LayerGroup | null>(null);
  const baseLayers = useRef<Record<LayerKey, L.LayerGroup> | null>(null);
  const onPickRef = useRef(onPick);
  const lockedRef = useRef(locked);

  const [layer, setLayer] = useState<LayerKey>("map");
  const [tilesLoading, setTilesLoading] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  /** 高ズームのタイルが無い範囲（世界タイル未設定 かつ 日本国外）にいる */
  const [outOfRange, setOutOfRange] = useState(false);

  onPickRef.current = onPick;
  lockedRef.current = locked;

  /* --- 初期化（1回だけ） --- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      // ダブルタップで拡大できた方が片手操作しやすい
      doubleClickZoom: true,
      zoomControl: false,
      worldCopyJump: true,
      minZoom: 2,
      maxZoom: 19,
      tapTolerance: 24,
      wheelPxPerZoomLevel: 90,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
    }).setView([35.681, 139.767], 4);

    L.control.zoom({ position: "topright" }).addTo(map);
    map.attributionControl.setPrefix("");

    baseLayers.current = {
      map: buildBaseLayer("map", setTilesLoading),
      photo: buildBaseLayer("photo", setTilesLoading),
    };
    baseLayers.current.map.addTo(map);
    trailLayer.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (lockedRef.current) return;
      onPickRef.current(e.latlng.lat, e.latlng.lng);
    });

    // 地理院タイルは日本国内のみ高ズームに対応している。
    // 世界タイルを設定していない状態で国外をズームすると空白になるので案内を出す
    const checkRange = () => {
      const hasWorld = Boolean(WORLD_MAP_URL || WORLD_PHOTO_URL);
      if (hasWorld) {
        setOutOfRange(false);
        return;
      }
      const c = map.getCenter();
      setOutOfRange(map.getZoom() >= 9 && !insideJapan(c.lat, c.lng));
    };
    map.on("moveend zoomend", checkRange);
    checkRange();

    mapRef.current = map;

    // 小窓⇔全画面の切り替えでサイズが変わるので追従させる
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* --- 表示サイズが変わったら再計測 --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize({ animate: false }), 260);
    return () => window.clearTimeout(t);
  }, [compact]);

  /* --- ベースレイヤー切り替え --- */
  useEffect(() => {
    const map = mapRef.current;
    const layers = baseLayers.current;
    if (!map || !layers) return;
    (Object.keys(layers) as LayerKey[]).forEach((key) => {
      if (key === layer) layers[key].addTo(map);
      else map.removeLayer(layers[key]);
    });
  }, [layer]);

  /* --- 自分のピン --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!markerPosition) {
      guessMarker.current?.remove();
      guessMarker.current = null;
      return;
    }
    const latlng = L.latLng(markerPosition.lat, markerPosition.lng);
    if (guessMarker.current) {
      guessMarker.current.setLatLng(latlng);
    } else {
      // タップだけだと数十m単位でしか置けないので、ドラッグで微調整できるようにする
      const marker = L.marker(latlng, { icon: guessPinIcon, keyboard: false, draggable: true, autoPan: true }).addTo(map);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        if (!lockedRef.current) onPickRef.current(p.lat, p.lng);
      });
      guessMarker.current = marker;
    }
    guessMarker.current.dragging?.[locked ? "disable" : "enable"]();
  }, [markerPosition, locked]);

  /* --- 正解ピンと結果ライン --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    resultLine.current?.remove();
    resultLine.current = null;

    if (!targetPosition) {
      targetMarker.current?.remove();
      targetMarker.current = null;
      return;
    }

    const target = L.latLng(targetPosition.lat, targetPosition.lng);
    if (targetMarker.current) targetMarker.current.setLatLng(target);
    else targetMarker.current = L.marker(target, { icon: targetPinIcon, keyboard: false }).addTo(map);

    if (markerPosition) {
      const guess = L.latLng(markerPosition.lat, markerPosition.lng);
      resultLine.current = L.polyline([guess, target], {
        color: "#4FD1A5",
        weight: 2,
        dashArray: "6 6",
        opacity: 0.9,
      }).addTo(map);
      map.fitBounds(L.latLngBounds([guess, target]), { padding: [56, 56], maxZoom: 12 });
    } else {
      map.setView(target, 9);
    }
  }, [targetPosition, markerPosition]);

  /* --- 逃走者の軌跡 --- */
  useEffect(() => {
    const group = trailLayer.current;
    if (!group) return;
    group.clearLayers();
    if (trail.length === 0) return;

    const points = trail.map((p) => L.latLng(p.lat, p.lng));
    if (points.length > 1) {
      L.polyline(points, { color: "#F2B441", weight: 2, opacity: 0.55, dashArray: "2 8" }).addTo(group);
    }

    points.forEach((p, i) => {
      const isLatest = i === points.length - 1;
      // ラウンド番号はサーバーが送ってくるものを使う。
      // 配列の添字だと、古い分が切り捨てられたときにズレて別ラウンドの番号が出てしまう
      const round = trail[i].round ?? i + 1;
      L.circleMarker(p, {
        radius: isLatest ? 8 : 5,
        color: "#F2B441",
        weight: isLatest ? 3 : 2,
        fillColor: isLatest ? "#F2B441" : "#0B1210",
        fillOpacity: 1,
      })
        .bindTooltip(isLatest ? `R${round}（直前にいた場所）` : `R${round}`, {
          direction: "top",
          permanent: isLatest && points.length > 1,
          className: isLatest ? "trail-tip is-latest" : "trail-tip",
        })
        .addTo(group);
    });
  }, [trail]);

  const fitAll = () => {
    const map = mapRef.current;
    if (!map) return;
    const points: L.LatLng[] = [];
    if (markerPosition) points.push(L.latLng(markerPosition.lat, markerPosition.lng));
    if (targetPosition) points.push(L.latLng(targetPosition.lat, targetPosition.lng));
    trail.forEach((p) => points.push(L.latLng(p.lat, p.lng)));
    if (points.length === 0) map.setView([35.681, 139.767], 4);
    else if (points.length === 1) map.setView(points[0], 10);
    else map.fitBounds(L.latLngBounds(points), { padding: [56, 56] });
  };

  return (
    <div className={`map-wrap${compact ? " is-compact" : ""}`}>
      <div ref={containerRef} className="map-canvas" />

      {tilesLoading && !compact && (
        <div className="map-loading" role="status">
          <span className="street-spinner" aria-hidden="true" />
          地図を読み込み中
        </div>
      )}

      <div className="map-controls">
        <button
          type="button"
          className="map-btn"
          aria-pressed={layer === "photo"}
          onClick={(e) => {
            e.stopPropagation();
            setLayer((l) => (l === "map" ? "photo" : "map"));
            setShowCredits(false);
          }}
        >
          {layer === "map" ? "写真" : "地図"}
        </button>
        <button
          type="button"
          className="map-btn"
          onClick={(e) => {
            e.stopPropagation();
            fitAll();
          }}
        >
          全体
        </button>
        {markerPosition && (
          <button
            type="button"
            className="map-btn"
            onClick={(e) => {
              e.stopPropagation();
              mapRef.current?.setView(L.latLng(markerPosition.lat, markerPosition.lng), 15);
            }}
          >
            ピンへ
          </button>
        )}
        {onExplore && (
          <button
            type="button"
            className="map-btn is-accent"
            disabled={exploreLoading}
            onClick={(e) => {
              e.stopPropagation();
              onExplore();
            }}
          >
            {exploreLoading ? "検索中…" : "下見"}
          </button>
        )}
      </div>

      {/* 地理院タイルは低ズームで他機関のデータを含むため、全文の出所を出せるようにする */}
      {!compact && (
        <>
          <button
            type="button"
            className="map-credit-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowCredits((v) => !v);
            }}
          >
            出典
          </button>
          {showCredits && (
            <div className="map-credit-panel" onClick={(e) => e.stopPropagation()}>
              {GSI_CREDITS.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {WORLD_ATTRIBUTION && <p>世界範囲のタイル: {WORLD_ATTRIBUTION}</p>}
            </div>
          )}
        </>
      )}

      {outOfRange && !compact && <div className="map-range-note">この範囲の詳細な地図は日本国内のみです</div>}

      {locked && <div className="map-lock-note">回答受付は終了しました</div>}
    </div>
  );
}