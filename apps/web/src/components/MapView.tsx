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
   地図タイル — 完全無料・商用利用可のものだけで構成する

   ■ 地図（street map）: OpenFreeMap
     ・登録もAPIキーも不要。表示数・リクエスト数とも無制限
     ・商用利用可。OpenStreetMapデータ + MapLibre のベクタータイル
     ・世界中をカバーし、拡大しても文字が潰れない（ベクターなので）
     tile.openstreetmap.org の公式ラスタタイルは「アプリ配布のような重い利用は
     事前許可なしには禁止」というポリシーがあるため使っていない。

   ■ 写真（航空・衛星）: 地理院タイル
     ・完全無料・キー不要・商用可（出典明示のみ）
     ・オルソ化した航空写真の合成なので雲がほぼ写らない
     ・日本国内はズーム18まで。ズーム2〜8は世界衛星モザイクで全世界

   ■ 写真の上の地名: OpenFreeMap のラベルだけを抜き出したスタイルを重ねる
     ・これで衛星写真でも市区町村名や国名が読める（世界中で機能する）
   ========================================================================== */

const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OFM_TILEJSON = "https://tiles.openfreemap.org/planet";
const OFM_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const GSI_LIST_URL = "https://maps.gsi.go.jp/development/ichiran.html";
const GSI_PALE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const GSI_PHOTO_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";

/** 404時に赤いバツ画像を出さないための透明1pxタイル */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** 世界の航空写真を高ズームまで足したい場合だけ設定する（任意） */
const WORLD_PHOTO_URL = import.meta.env.VITE_WORLD_PHOTO_URL as string | undefined;
const WORLD_ATTRIBUTION = (import.meta.env.VITE_WORLD_ATTRIBUTION as string | undefined) ?? "";
const WORLD_TILE_SIZE = Number(import.meta.env.VITE_WORLD_TILE_SIZE ?? 256) || 256;

const CREDITS = [
  "地図: © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
  "航空写真: 国土地理院「地理院タイル（写真）」",
  "写真 ズーム9〜13: データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）",
  "写真 ズーム2〜8: Images on 世界衛星モザイク画像 obtained from site https://lpdaac.usgs.gov/data_access maintained by the NASA Land Processes Distributed Active Archive Center (LP DAAC), USGS/Earth Resources Observation and Science (EROS) Center, Sioux Falls, South Dakota. Source of image data product.",
  "一部にGRUS画像（© Axelspace）を含みます。",
];

/** 地理院の航空写真が高ズームに対応している範囲（日本とその周辺） */
const JAPAN = { minLat: 20.0, maxLat: 46.5, minLng: 122.0, maxLng: 154.0 };

function insideJapan(lat: number, lng: number) {
  return lat >= JAPAN.minLat && lat <= JAPAN.maxLat && lng >= JAPAN.minLng && lng <= JAPAN.maxLng;
}

/**
 * 写真の上に重ねる「地名だけ」のスタイル。
 * background レイヤーを持たないので下の写真がそのまま透ける。
 */
const LABELS_STYLE = {
  version: 8,
  sources: {
    openmaptiles: { type: "vector", url: OFM_TILEJSON },
  },
  glyphs: OFM_GLYPHS,
  layers: [
    {
      id: "place-labels",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: [
        "in",
        ["get", "class"],
        ["literal", ["continent", "country", "state", "city", "town", "village", "suburb"]],
      ],
      layout: {
        // 日本語名があれば優先し、無ければラテン文字、それも無ければ既定名
        "text-field": ["coalesce", ["get", "name:ja"], ["get", "name:latin"], ["get", "name"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 8, 13, 12, 15, 16, 17],
        "text-max-width": 8,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.85)",
        "text-halo-width": 1.8,
      },
    },
  ],
};

type LayerKey = "map" | "photo";

/** 緯度経度を読みやすい桁で文字列にする（小数5桁 ≒ 1m） */
function formatLatLng(p: LatLng) {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
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

  /** ベクター地図（OpenFreeMap）。読み込みに失敗したら null のまま */
  const vectorBase = useRef<L.Layer | null>(null);
  /** ベクターが使えないときのラスタ地図（地理院淡色地図） */
  const rasterBase = useRef<L.TileLayer | null>(null);
  /** 航空写真 */
  const photoBase = useRef<L.LayerGroup | null>(null);
  /** 写真の上に重ねる地名 */
  const labelsLayer = useRef<L.Layer | null>(null);

  const onPickRef = useRef(onPick);
  const lockedRef = useRef(locked);
  const layerRef = useRef<LayerKey>("map");
  const labelsOnRef = useRef(true);

  const [layer, setLayer] = useState<LayerKey>("map");
  const [labelsOn, setLabelsOn] = useState(true);
  const [tilesLoading, setTilesLoading] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 航空写真が高ズームに無い範囲（世界タイル未設定 かつ 日本国外）にいる */
  const [outOfPhotoRange, setOutOfPhotoRange] = useState(false);

  onPickRef.current = onPick;
  lockedRef.current = locked;
  layerRef.current = layer;
  labelsOnRef.current = labelsOn;

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

    /* --- 航空写真レイヤー --- */
    const photo = L.layerGroup();
    if (WORLD_PHOTO_URL) {
      L.tileLayer(WORLD_PHOTO_URL, {
        attribution: WORLD_ATTRIBUTION,
        maxZoom: 19,
        maxNativeZoom: 19,
        tileSize: WORLD_TILE_SIZE,
        zoomOffset: WORLD_TILE_SIZE === 512 ? -1 : 0,
        errorTileUrl: BLANK_TILE,
        zIndex: 1,
      }).addTo(photo);
    }
    const gsiPhoto = L.tileLayer(GSI_PHOTO_URL, {
      attribution: `<a href="${GSI_LIST_URL}" target="_blank" rel="noreferrer">地理院タイル</a>（写真）`,
      maxZoom: 19,
      maxNativeZoom: 18,
      // 世界タイルがあるときは、地理院の粗い世界モザイクで上書きしない
      minZoom: WORLD_PHOTO_URL ? 9 : 2,
      errorTileUrl: BLANK_TILE,
      zIndex: 2,
    });
    gsiPhoto.on("loading", () => setTilesLoading(true));
    gsiPhoto.on("load", () => setTilesLoading(false));
    gsiPhoto.addTo(photo);
    photoBase.current = photo;

    /* --- 地図レイヤー（まずラスタで出しておき、ベクターが来たら差し替える） --- */
    const raster = L.tileLayer(GSI_PALE_URL, {
      attribution: `<a href="${GSI_LIST_URL}" target="_blank" rel="noreferrer">地理院タイル</a>（淡色地図）`,
      maxZoom: 19,
      maxNativeZoom: 18,
      errorTileUrl: BLANK_TILE,
    });
    raster.on("loading", () => setTilesLoading(true));
    raster.on("load", () => setTilesLoading(false));
    rasterBase.current = raster;
    raster.addTo(map);

    trailLayer.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (lockedRef.current) return;
      onPickRef.current(e.latlng.lat, e.latlng.lng);
    });

    // 地理院の航空写真は日本国内のみ高ズームに対応している
    const checkPhotoRange = () => {
      if (WORLD_PHOTO_URL) {
        setOutOfPhotoRange(false);
        return;
      }
      const c = map.getCenter();
      setOutOfPhotoRange(layerRef.current === "photo" && map.getZoom() >= 9 && !insideJapan(c.lat, c.lng));
    };
    map.on("moveend zoomend", checkPhotoRange);
    checkPhotoRange();

    mapRef.current = map;

    /* --- OpenFreeMap（MapLibre）を後から読み込む --- *
       重いライブラリなので初期表示をブロックしない。
       読み込みに失敗しても地理院ラスタのまま動き続ける。 */
    let disposed = false;
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        await import("maplibre-gl/dist/maplibre-gl.css");
        // プラグインはグローバルの maplibregl / L を参照するUMDスクリプト
        (window as any).maplibregl = (maplibre as any).default ?? maplibre;
        (window as any).L = L;
        await import("@maplibre/maplibre-gl-leaflet");
        if (disposed || !(L as any).maplibreGL) return;

        vectorBase.current = (L as any).maplibreGL({
          style: OFM_STYLE_URL,
          attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
        });
        labelsLayer.current = (L as any).maplibreGL({ style: LABELS_STYLE, attribution: "" });

        // すでに地図タブを見ているなら、その場でベクターへ差し替える
        if (layerRef.current === "map" && mapRef.current) {
          mapRef.current.removeLayer(raster);
          vectorBase.current!.addTo(mapRef.current);
        }
        if (layerRef.current === "photo" && labelsOnRef.current && mapRef.current) {
          labelsLayer.current!.addTo(mapRef.current);
        }
      } catch (err) {
        console.error("MapLibre load failed, falling back to raster tiles", err);
      }
    })();

    // 小窓⇔全画面の切り替えでサイズが変わるので追従させる
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
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

  /* --- レイヤー切り替え（地図 ⇔ 写真、地名の on/off） --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const base = vectorBase.current ?? rasterBase.current;
    const photo = photoBase.current;
    const labels = labelsLayer.current;

    if (layer === "map") {
      if (photo && map.hasLayer(photo)) map.removeLayer(photo);
      if (labels && map.hasLayer(labels)) map.removeLayer(labels);
      if (base && !map.hasLayer(base)) base.addTo(map);
    } else {
      if (base && map.hasLayer(base)) map.removeLayer(base);
      if (photo && !map.hasLayer(photo)) photo.addTo(map);
      if (labels) {
        if (labelsOn && !map.hasLayer(labels)) labels.addTo(map);
        if (!labelsOn && map.hasLayer(labels)) map.removeLayer(labels);
      }
    }

    // 表示範囲の案内を更新する
    if (!WORLD_PHOTO_URL) {
      const c = map.getCenter();
      setOutOfPhotoRange(layer === "photo" && map.getZoom() >= 9 && !insideJapan(c.lat, c.lng));
    }
  }, [layer, labelsOn]);

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

  const copyCoords = async () => {
    if (!markerPosition) return;
    try {
      await navigator.clipboard.writeText(formatLatLng(markerPosition));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* クリップボードが使えない環境 */
    }
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

      {/* ピンを置いた場所の座標。タップでコピーできる */}
      {markerPosition && !compact && (
        <button type="button" className="map-coords" onClick={(e) => { e.stopPropagation(); copyCoords(); }}>
          <span className="map-coords-label">ピンの座標</span>
          <span className="map-coords-value">{formatLatLng(markerPosition)}</span>
          <span className="map-coords-copy">{copied ? "コピーしました" : "タップでコピー"}</span>
        </button>
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
        {layer === "photo" && (
          <button
            type="button"
            className="map-btn"
            aria-pressed={labelsOn}
            onClick={(e) => {
              e.stopPropagation();
              setLabelsOn((v) => !v);
            }}
          >
            {labelsOn ? "地名 ON" : "地名 OFF"}
          </button>
        )}
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

      {/* 低ズーム側は他機関のデータを含むため、全文の出所を出せるようにする */}
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
              {CREDITS.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {WORLD_ATTRIBUTION && <p>世界範囲の写真: {WORLD_ATTRIBUTION}</p>}
            </div>
          )}
        </>
      )}

      {outOfPhotoRange && !compact && (
        <div className="map-range-note">この範囲の航空写真は日本国内のみです</div>
      )}

      {locked && <div className="map-lock-note">回答受付は終了しました</div>}
    </div>
  );
}