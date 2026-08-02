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

const MLY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;
const MLY_TILES = MLY_TOKEN
  ? `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${MLY_TOKEN}`
  : null;

const guessPinIcon = makePinIcon("#E0483E");

// Search & Chase: 逃走者の「移動先候補」(映像で下見している場所)
const scoutIcon = L.divIcon({
  className: "scout-icon",
  html: '<span class="scout-dot"></span><span class="scout-label">移動先候補</span>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

// Search & Chase: 逃走者本人にだけ見える「あなたの現在地」
const runnerSelfIcon = L.divIcon({
  className: "runner-self-icon",
  html: '<span class="runner-self-dot"></span><span class="runner-self-label">あなた</span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const targetPinIcon = makePinIcon("#4FD1A5");

// 地図タイルは完全無料・商用可のものだけ。
// tile.openstreetmap.org は重い利用が禁止されているため使わない。
// OpenFreeMap は無料・商用可・APIキー不要（https://openfreemap.org）。
// Googleマップに近い明るい配色で、POI（建物名）が最も多い bright スタイルを使う
const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/bright";

const GSI_PALE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const GSI_STD_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const GSI_PHOTO_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";

const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const WORLD_PHOTO_URL = import.meta.env.VITE_WORLD_PHOTO_URL as string | undefined;
const WORLD_TILE_SIZE = Number(import.meta.env.VITE_WORLD_TILE_SIZE ?? 256) || 256;

const JAPAN = { minLat: 20.0, maxLat: 46.5, minLng: 122.0, maxLng: 154.0 };

function insideJapan(lat: number, lng: number) {
  return lat >= JAPAN.minLat && lat <= JAPAN.maxLat && lng >= JAPAN.minLng && lng <= JAPAN.maxLng;
}

type LayerKey = "map" | "photo";

function formatLatLng(p: LatLng) {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

/** ラベルは日本語優先（Googleマップと同じ見え方にする） */
const JA_NAME = ["coalesce", ["get", "name:ja"], ["get", "name"], ["get", "name:latin"]];

/**
 * OpenFreeMap の bright スタイルを取得して、日本向けに加工する。
 *  - すべてのラベルを日本語優先の1段表示にする（既定は「ローマ字＋現地語」の2段）
 *  - 都道府県境（admin_level=4）をGoogle風の紫の破線で強調するレイヤーを追加
 *  - 県名ラベル（class=state）をズーム12まで表示し、日本語・非斜体にする
 *  - POI（建物・店の名前）の表示開始ズームを下げて数を増やす
 * 取得に失敗したら null を返し、呼び出し側は素のスタイルURLで初期化する。
 */
async function buildJapaneseStyle(): Promise<unknown | null> {
  try {
    const res = await fetch(OFM_STYLE_URL);
    if (!res.ok) return null;
    const style = (await res.json()) as any;
    if (!Array.isArray(style?.layers) || !style?.sources) return null;

    const srcId = Object.keys(style.sources).find((k) => style.sources[k]?.type === "vector");
    if (!srcId) return null;

    for (const layer of style.layers) {
      const layout = layer.layout as Record<string, unknown> | undefined;
      if (layout && layout["text-field"]) {
        layout["text-field"] = JA_NAME;
      }
      // 建物名・店名（POI）: ランクによる間引きと遅い表示開始をやめ、
      // 名前を持つ地物はズーム14以降すべて表示する
      if (layer["source-layer"] === "poi" && layer.type === "symbol") {
        if (typeof layer.minzoom === "number") layer.minzoom = Math.min(14, Math.max(12, layer.minzoom - 3));
        // rank<=N のような間引きフィルタを外す(名前があるものは全部)
        if (Array.isArray(layer.filter)) {
          const stripRank = (f: any): any => {
            if (!Array.isArray(f)) return f;
            if (f.length >= 2 && (f[1] === "rank" || (Array.isArray(f[1]) && f[1][1] === "rank"))) return true;
            if (f[0] === "all" || f[0] === "any") {
              const inner = f.slice(1).map(stripRank).filter((x: any) => x !== true);
              return inner.length > 0 ? [f[0], ...inner] : true;
            }
            return f;
          };
          const stripped = stripRank(layer.filter);
          if (stripped === true) delete layer.filter;
          else layer.filter = stripped;
        }
        layer.layout = { ...(layer.layout as any), "symbol-sort-key": ["coalesce", ["get", "rank"], 30] };
      }
      // 県名: 既定は maxzoom 8 で消えて英字斜体。日本語・太字でズーム12まで残す
      if (layer.id === "label_state") {
        layer.maxzoom = 12;
        layer.layout = {
          ...layout,
          "text-field": JA_NAME,
          "text-font": ["Noto Sans Bold"],
          "text-transform": "none",
          "text-letter-spacing": 0.06,
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 8, 15, 11, 13],
        };
        layer.paint = {
          ...layer.paint,
          "text-color": "#7b5aa6",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        };
      }
    }

    // 都道府県境。淡い縁取り＋紫の破線（Googleマップの行政界に寄せる）
    const boundaryFilter = ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]];
    const prefCasing = {
      id: "geochase-pref-casing",
      type: "line",
      source: srcId,
      "source-layer": "boundary",
      minzoom: 4,
      filter: boundaryFilter,
      paint: {
        "line-color": "#b39ddb",
        "line-opacity": 0.35,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 8, 5, 12, 8],
      },
    };
    const prefLine = {
      id: "geochase-pref-line",
      type: "line",
      source: srcId,
      "source-layer": "boundary",
      minzoom: 4,
      filter: boundaryFilter,
      paint: {
        "line-color": "#7e57c2",
        "line-opacity": 0.9,
        "line-dasharray": [3, 2],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 8, 1.6, 12, 2.4],
      },
    };

    // 国道・県道・高速などの路線番号。標識風に色分けして道路上へ載せる
    // (高速=緑 / 国道=青 / それ以外のref持ち=白地)
    const roadRefBase = {
      type: "symbol" as const,
      source: srcId,
      "source-layer": "transportation_name",
      minzoom: 8,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 340,
        "text-field": ["to-string", ["get", "ref"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 12, 11, 16, 13],
        "text-rotation-alignment": "viewport",
        "text-pitch-alignment": "viewport",
        "text-padding": 2,
      },
    };
    const hasRef = ["all", ["has", "ref"], ["!=", ["get", "ref"], ""]];
    const refMotorway = {
      ...roadRefBase,
      id: "geochase-ref-motorway",
      filter: ["all", hasRef, ["==", ["get", "class"], "motorway"]],
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#1e8a3c",
        "text-halo-width": 2.4,
      },
    };
    const refNational = {
      ...roadRefBase,
      id: "geochase-ref-national",
      filter: ["all", hasRef, ["in", ["get", "class"], ["literal", ["trunk", "primary"]]]],
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#1a5fb4",
        "text-halo-width": 2.4,
      },
    };
    const refOther = {
      ...roadRefBase,
      id: "geochase-ref-other",
      minzoom: 10,
      filter: [
        "all",
        hasRef,
        ["!", ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]]],
      ],
      paint: {
        "text-color": "#4a4034",
        "text-halo-color": "#fff8e6",
        "text-halo-width": 2.2,
      },
    };

    // ラベル（symbol）の直前に挿入して、文字が線に隠れないようにする
    const firstSymbol = style.layers.findIndex((l: any) => l.type === "symbol");
    const at = firstSymbol >= 0 ? firstSymbol : style.layers.length;
    style.layers.splice(at, 0, prefCasing, prefLine);
    // 路線番号は最上位(他ラベルの上)に置く
    style.layers.push(refMotorway, refNational, refOther);
    return style;
  } catch (err) {
    console.error("style build failed", err);
    return null;
  }
}

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: LatLng | null;
  /** Search & Chase: 逃走者本人の現在地(本人以外はnull) */
  runnerPos?: LatLng | null;
  /** Search & Chase: 逃走者が映像で下見中の地点 */
  scoutPos?: LatLng | null;
  targetPosition?: LatLng | null;
  trail?: TrailPoint[];
  locked?: boolean;
  compact?: boolean;
  onExplore?: () => void;
  exploreLoading?: boolean;
  /** 場所選び中: 360°カバレッジ(緑線)を自動で表示する */
  coverageHint?: boolean;
  panTo?: LatLng | null;
}

export default function MapView({
  onPick,
  markerPosition,
  runnerPos,
  scoutPos,
  targetPosition,
  trail = [],
  locked = false,
  compact = false,
  onExplore,
  exploreLoading = false,
  coverageHint = false,
  panTo = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  // 撮影カバレッジの重ね表示: 緑=360°(候補になれる道) / 灰青=平面のみ
  const [showPano, setShowPano] = useState(false);
  const [showFlat, setShowFlat] = useState(false);
  const glMapRef = useRef<any>(null);

  const ensureCoverageLayers = (gl: any) => {
    if (!MLY_TILES || !gl || gl.getSource("mly-coverage")) return;
    try {
      gl.addSource("mly-coverage", {
        type: "vector",
        tiles: [MLY_TILES],
        minzoom: 0,
        maxzoom: 14,
      });
      gl.addLayer({
        id: "mly-flat",
        type: "line",
        source: "mly-coverage",
        "source-layer": "sequence",
        filter: ["!=", ["get", "is_pano"], true],
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": "#6b8cae",
          "line-opacity": 0.75,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 12, 1.6, 16, 2.4],
        },
      });
      gl.addLayer({
        id: "mly-pano",
        type: "line",
        source: "mly-coverage",
        "source-layer": "sequence",
        filter: ["==", ["get", "is_pano"], true],
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": "#17b26a",
          "line-opacity": 0.9,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.4, 12, 2.6, 16, 3.6],
        },
      });
    } catch (err) {
      console.error("coverage layers failed", err);
    }
  };
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
      // 出典はゲーム中の画面には出さず「記録」タブに常設する（credits.ts）
      attributionControl: false,
      worldCopyJump: true,
      minZoom: 2,
      maxZoom: 19,
      tapTolerance: 24,
      wheelPxPerZoomLevel: 90,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
    }).setView([35.681, 139.767], 4);

    // Googleマップと同じくズームは右下
    // ズームの＋−ボタンは置かない。ピンチ/ホイール/ダブルタップで操作する

    const photo = L.layerGroup();
    if (WORLD_PHOTO_URL) {
      L.tileLayer(WORLD_PHOTO_URL, {
        maxZoom: 19,
        maxNativeZoom: 19,
        tileSize: WORLD_TILE_SIZE,
        zoomOffset: WORLD_TILE_SIZE === 512 ? -1 : 0,
        errorTileUrl: BLANK_TILE,
        zIndex: 1,
      }).addTo(photo);
    }
    const gsiPhoto = L.tileLayer(GSI_PHOTO_URL, {
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
        const [maplibre, style] = await Promise.all([import("maplibre-gl"), buildJapaneseStyle()]);
        await import("maplibre-gl/dist/maplibre-gl.css");
        (window as any).maplibregl = (maplibre as any).default ?? maplibre;
        (window as any).L = L;
        await import("@maplibre/maplibre-gl-leaflet");
        if (disposed || !(L as any).maplibreGL) return;

        vectorBase.current = (L as any).maplibreGL({
          // 加工に失敗した場合は素の bright スタイルURLで動かす
          style: style ?? OFM_STYLE_URL,
        });
        const vb: any = vectorBase.current;
        const grabGl = () => {
          try {
            const gl = vb?.getMaplibreMap?.();
            if (!gl) return;
            glMapRef.current = gl;
            if (gl.isStyleLoaded?.()) ensureCoverageLayers(gl);
            else gl.once?.("load", () => ensureCoverageLayers(gl));
          } catch {}
        };
        vb?.on?.("add", grabGl);
        grabGl();

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
        if (labelsOn && !map.hasLayer(labels)) labels.addTo(map);
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

  useEffect(() => {
    if (coverageHint) setShowPano(true);
  }, [coverageHint]);

  // カバレッジ表示の切替をGLレイヤーへ反映
  useEffect(() => {
    const gl = glMapRef.current;
    if (!gl) return;
    ensureCoverageLayers(gl);
    try {
      if (gl.getLayer("mly-pano")) gl.setLayoutProperty("mly-pano", "visibility", showPano ? "visible" : "none");
      if (gl.getLayer("mly-flat")) gl.setLayoutProperty("mly-flat", "visibility", showFlat ? "visible" : "none");
    } catch {}
  }, [showPano, showFlat]);

  // 逃走者の自位置マーカー(青い点)。位置が来たら出し、消えたら片付ける
  const runnerMarker = useRef<L.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!runnerPos) {
      runnerMarker.current?.remove();
      runnerMarker.current = null;
      return;
    }
    const latlng = L.latLng(runnerPos.lat, runnerPos.lng);
    if (runnerMarker.current) runnerMarker.current.setLatLng(latlng);
    else runnerMarker.current = L.marker(latlng, { icon: runnerSelfIcon, keyboard: false, interactive: false }).addTo(map);
  }, [runnerPos]);

  // 下見中の地点(中抜きの青)。確定位置と区別する
  const scoutMarker = useRef<L.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!scoutPos) {
      scoutMarker.current?.remove();
      scoutMarker.current = null;
      return;
    }
    const latlng = L.latLng(scoutPos.lat, scoutPos.lng);
    if (scoutMarker.current) scoutMarker.current.setLatLng(latlng);
    else scoutMarker.current = L.marker(latlng, { icon: scoutIcon, keyboard: false, interactive: false }).addTo(map);
  }, [scoutPos]);

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

      {MLY_TILES && !compact && (
        <div className="map-layers" role="group" aria-label="撮影データの表示">
          <button
            type="button"
            className={`map-layer-btn${showPano ? " is-on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setShowPano((v) => !v);
            }}
            title="車載を含む360°パノラマがある道を緑の線で表示します(隠れ場所に選べるのはこの近く)"
          >
            🟢 360°の道
          </button>
          <button
            type="button"
            className={`map-layer-btn${showFlat ? " is-on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setShowFlat((v) => !v);
            }}
            title="360°ではない撮影(平面写真)だけがある道を表示します(隠れ場所には選べません)"
          >
            ⚪ 平面のみの道
          </button>
        </div>
      )}

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

      {outOfPhotoRange && !compact && (
        <div className="map-range-note">この範囲の航空写真は日本国内のみです</div>
      )}

      {locked && <div className="map-lock-note">回答受付は終了しました</div>}
    </div>
  );
}
