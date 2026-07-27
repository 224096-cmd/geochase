import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { LatLng } from "../lib/types";

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

/**
 * NASA GIBS: 米国政府機関のデータでパブリックドメイン相当。APIキー不要・商用利用可。
 * タイルは日付つきで当日分が未生成のことがあるため2日前を指定する。
 */
function gibsUrl() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 2);
  const date = d.toISOString().slice(0, 10);
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

type LayerKey = "map" | "satellite";

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: LatLng | null;
  targetPosition?: LatLng | null;
  /** 決着済みラウンドでAIがいた場所 */
  trail?: LatLng[];
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
  const baseLayers = useRef<Record<LayerKey, L.TileLayer> | null>(null);
  const onPickRef = useRef(onPick);
  const lockedRef = useRef(locked);
  const [layer, setLayer] = useState<LayerKey>("map");

  onPickRef.current = onPick;
  lockedRef.current = locked;

  const satelliteUrl = useMemo(() => gibsUrl(), []);

  /* --- 初期化（1回だけ） --- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      // ダブルタップで拡大できた方が片手操作しやすい
      doubleClickZoom: true,
      zoomControl: false,
      worldCopyJump: true,
      minZoom: 2,
      maxZoom: 18,
      tapTolerance: 24,
      wheelPxPerZoomLevel: 90,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
    }).setView([35.681, 139.767], 4);

    L.control.zoom({ position: "topright" }).addTo(map);
    map.attributionControl.setPrefix("");

    baseLayers.current = {
      map: L.tileLayer(OSM_TILE_URL, {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 18,
      }),
      // maxNativeZoom が無いと z9 より寄れず、ピンを正確に置けなかった。
      // 実タイルは z9 まで、それ以上は拡大表示にして細かい位置指定を可能にする。
      satellite: L.tileLayer(satelliteUrl, {
        attribution: "NASA EOSDIS GIBS",
        maxZoom: 18,
        maxNativeZoom: 9,
      }),
    };
    baseLayers.current.map.addTo(map);
    trailLayer.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (lockedRef.current) return;
      onPickRef.current(e.latlng.lat, e.latlng.lng);
    });

    mapRef.current = map;

    // 小窓⇔全画面の切り替えでサイズが変わるので追従させる
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [satelliteUrl]);

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
      const marker = L.marker(latlng, { icon: guessPinIcon, keyboard: false, draggable: true, autoPan: true })
        .addTo(map);
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

  /* --- AIの軌跡 --- */
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
      L.circleMarker(p, {
        radius: 5,
        color: "#F2B441",
        weight: 2,
        fillColor: "#0B1210",
        fillOpacity: 1,
      })
        .bindTooltip(`第${i + 1}地点`, { direction: "top" })
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

      <div className="map-controls">
        <button
          type="button"
          className="map-btn"
          aria-pressed={layer === "satellite"}
          onClick={(e) => {
            e.stopPropagation();
            setLayer((l) => (l === "map" ? "satellite" : "map"));
          }}
        >
          {layer === "map" ? "衛星" : "地図"}
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
            {exploreLoading ? "検索中" : "下見"}
          </button>
        )}
      </div>

      {locked && <div className="map-lock-note">回答受付は終了しました</div>}
    </div>
  );
}