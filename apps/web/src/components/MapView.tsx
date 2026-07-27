import { useEffect, useRef, useState } from "react";
import L from "leaflet";

function makePinIcon(color: string) {
  return L.divIcon({
    className: "geo-pin",
    html: `<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${color}"/>
      <circle cx="15" cy="15" r="6" fill="#fff"/>
    </svg>`,
    iconSize: [30, 42],
    iconAnchor: [15, 42],
  });
}
const guessPinIcon = makePinIcon("#e0483e");
const targetPinIcon = makePinIcon("#4fd1a5");

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: { lat: number; lng: number } | null;
  targetPosition?: { lat: number; lng: number } | null;
}

// NASA GIBS: 米国政府機関のデータでパブリックドメイン相当。APIキー不要・商用利用可。
const today = new Date();
today.setDate(today.getDate() - 2);
const gibsDate = today.toISOString().slice(0, 10);
const SATELLITE_TILE_URL = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${gibsDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

const LABEL_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

export default function MapView({ onPick, markerPosition, targetPosition }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const targetMarkerRef = useRef<L.Marker | null>(null);
  const satelliteLayerRef = useRef<L.TileLayer | null>(null);
  const labelLayerRef = useRef<L.TileLayer | null>(null);
  const onPickRef = useRef(onPick);
  const [layer, setLayer] = useState<"satellite" | "label">("satellite");

  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current, { doubleClickZoom: false }).setView([35.681, 139.767], 4);

    satelliteLayerRef.current = L.tileLayer(SATELLITE_TILE_URL, {
      attribution: "Imagery courtesy NASA GIBS",
      maxZoom: 9,
      maxNativeZoom: 9,
    }).addTo(map);

    labelLayerRef.current = L.tileLayer(LABEL_TILE_URL, {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    });

    map.on("click", (e: L.LeafletMouseEvent) => {
      onPickRef.current(e.latlng.lat, e.latlng.lng);
      if (markerRef.current) markerRef.current.setLatLng(e.latlng);
      else markerRef.current = L.marker(e.latlng, { icon: guessPinIcon }).addTo(map);
    });

    mapInstance.current = map;

    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(mapRef.current);
    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapInstance.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !satelliteLayerRef.current || !labelLayerRef.current) return;
    if (layer === "satellite") {
      map.addLayer(satelliteLayerRef.current);
      map.removeLayer(labelLayerRef.current);
    } else {
      map.addLayer(labelLayerRef.current);
      map.removeLayer(satelliteLayerRef.current);
    }
  }, [layer]);

  useEffect(() => {
    if (!mapInstance.current) return;
    if (!markerPosition) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const latlng = L.latLng(markerPosition.lat, markerPosition.lng);
    if (markerRef.current) markerRef.current.setLatLng(latlng);
    else markerRef.current = L.marker(latlng, { icon: guessPinIcon }).addTo(mapInstance.current);
  }, [markerPosition]);

  useEffect(() => {
    if (!mapInstance.current) return;
    if (!targetPosition) {
      targetMarkerRef.current?.remove();
      targetMarkerRef.current = null;
      return;
    }
    const latlng = L.latLng(targetPosition.lat, targetPosition.lng);
    if (targetMarkerRef.current) targetMarkerRef.current.setLatLng(latlng);
    else targetMarkerRef.current = L.marker(latlng, { icon: targetPinIcon }).addTo(mapInstance.current);
  }, [targetPosition]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
      <button
        className="layer-toggle"
        onClick={(e) => {
          e.stopPropagation();
          setLayer((l) => (l === "satellite" ? "label" : "satellite"));
        }}
      >
        {layer === "satellite" ? "🛰️ 航空写真" : "🗺️ 地名表示"}
      </button>
    </div>
  );
}