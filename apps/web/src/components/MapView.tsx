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

// 地図タイルは完全無料・商用可のものだけ。
// tile.openstreetmap.org は重い利用が禁止されているため使わない
const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

const GSI_LIST_URL = "https://maps.gsi.go.jp/development/ichiran.html";
const GSI_PALE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const GSI_STD_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const GSI_PHOTO_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";

const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const WORLD_PHOTO_URL = import.meta.env.VITE_WORLD_PHOTO_URL as string | undefined;
const WORLD_ATTRIBUTION = (import.meta.env.VITE_WORLD_ATTRIBUTION as string | undefined) ?? "";
const WORLD_TILE_SIZE = Number(import.meta.env.VITE_WORLD_TILE_SIZE ?? 256) || 256;

const CREDITS = [
  "地図: © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
  "ストリート画像: © Mapillary contributors（CC BY-SA 4.0）",
  "地名検索: © OpenStreetMap contributors / Nominatim（ODbL）",
  "航空写真・地名: 国土地理院「地理院タイル」（写真・標準地図・淡色地図）",
  "写真 ズーム9〜13: データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO）",
  "写真 ズーム2〜8: Images on 世界衛星モザイク画像 obtained from site https://lpdaac.usgs.gov/data_access maintained by the NASA Land Processes Distributed Active Archive Center (LP DAAC), USGS/Earth Resources Observation and Science (EROS) Center, Sioux Falls, South Dakota. Source of image data product.",
  "一部にGRUS画像（© Axelspace）を含みます。",
];

const JAPAN = { minLat: 20.0, maxLat: 46.5, minLng: 122.0, maxLng: 154.0 };

function insideJapan(lat: number, lng: number) {
  return lat >= JAPAN.minLat && lat <= JAPAN.maxLat && lng >= JAPAN.minLng && lng <= JAPAN.maxLng;
}

type LayerKey = "map" | "photo";

function formatLatLng(p: LatLng) {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: LatLng | null;
  targetPosition?: LatLng | null;
  trail?: TrailPoint[];
  locked?: boolean;
  compact?: boolean;
  onExplore?: () => void;
  exploreLoading?: boolean;
  panTo?: LatLng | null;
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
  panTo = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const guessMarker = useRef<L.Marker | null>(null);
  const targetMarker = useRef<L.Marker | null>(null);
  const resultLine = useRef<L.Polyline | null>(null);
  const trailLayer = useRef<L.LayerGroup | null>(null);

  const vectorBase = useRef<L.Layer | null>(null);
  const rasterBase = useRef<L.TileLayer | null>(null);
  const photoBase = useRef<L.LayerGroup | null>(null);
  const labelsLayer = useRef<L.TileLayer | null>(null);

  const onPickRef = useRef(onPick);
  const lockedRef = useRef(locked);
  const layerRef = useRef<LayerKey>("map");
  const lastPanRef = useRef("");

  const [layer, setLayer] = useState<LayerKey>("map");
  const [labelsOn, setLabelsOn] = useState(true);
  const [tilesLoading, setTilesLoading] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const [copied, setCopied] = useState(false);
  const [outOfPhotoRange, setOutOfPhotoRange] = useState(false);

  onPickRef.current = onPick;
  lockedRef.current = locked;
  layerRef.current = layer;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
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
      minZoom: WORLD_PHOTO_URL ? 9 : 2,
      errorTileUrl: BLANK_TILE,
      zIndex: 2,
    });
    gsiPhoto.on("loading", () => setTilesLoading(true));
    gsiPhoto.on("load", () => setTilesLoading(false));
    gsiPhoto.addTo(photo);
    photoBase.current = photo;

    // 写真の上に標準地図を multiply で重ねると、白背景は写真を通し文字と道路だけが残る
    labelsLayer.current = L.tileLayer(GSI_STD_URL, {
      maxZoom: 19,
      maxNativeZoom: 18,
      className: "map-labels-tiles",
      errorTileUrl: BLANK_TILE,
      zIndex: 5,
    });

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

    // MapLibreは重いので後から読み込む。失敗しても地理院ラスタのまま動く
    let disposed = false;
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        await import("maplibre-gl/dist/maplibre-gl.css");
        (window as any).maplibregl = (maplibre as any).default ?? maplibre;
        (window as any).L = L;
        await import("@maplibre/maplibre-gl-leaflet");
        if (disposed || !(L as any).maplibreGL) return;

        vectorBase.current = (L as any).maplibreGL({
          style: OFM_STYLE_URL,
          attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
        });

        if (layerRef.current === "map" && mapRef.current && vectorBase.current) {
          mapRef.current.removeLayer(raster);
          vectorBase.current.addTo(mapRef.current);
        }
      } catch (err) {
        console.error("MapLibre load failed, falling back to raster tiles", err);
      }
    })();

    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize({ animate: false }), 260);
    return () => window.clearTimeout(t);
  }, [compact]);

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
        if (labelsOn && !map.hasLayer(labels)) {
          labels.addTo(map);
          labels.bringToFront();
        }
        if (!labelsOn && map.hasLayer(labels)) map.removeLayer(labels);
      }
    }

    if (!WORLD_PHOTO_URL) {
      const c = map.getCenter();
      setOutOfPhotoRange(layer === "photo" && map.getZoom() >= 9 && !insideJapan(c.lat, c.lng));
    }
  }, [layer, labelsOn]);

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
      const marker = L.marker(latlng, { icon: guessPinIcon, keyboard: false, draggable: true, autoPan: true }).addTo(map);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        if (!lockedRef.current) onPickRef.current(p.lat, p.lng);
      });
      guessMarker.current = marker;
    }
    guessMarker.current.dragging?.[locked ? "disable" : "enable"]();
  }, [markerPosition, locked]);

  // 下見中の地点へ追従する。ズームは維持して中心だけ寄せる
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !panTo) return;
    const key = `${panTo.lat.toFixed(6)},${panTo.lng.toFixed(6)}`;
    if (key === lastPanRef.current) return;
    lastPanRef.current = key;
    const zoom = Math.max(map.getZoom(), 15);
    map.setView(L.latLng(panTo.lat, panTo.lng), zoom, { animate: true });
  }, [panTo]);

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
    } catch {}
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