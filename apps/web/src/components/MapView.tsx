import { useEffect, useRef } from "react";
import L from "leaflet";

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: { lat: number; lng: number } | null;
}

// AI逃走モードでは正解座標をクライアントに送らないため、
// このコンポーネントは「プレイヤーが立てたピン」だけを扱う。
export default function MapView({ onPick, markerPosition }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current).setView([35.681, 139.767], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      onPick(e.latlng.lat, e.latlng.lng);
      if (markerRef.current) {
        markerRef.current.setLatLng(e.latlng);
      } else {
        markerRef.current = L.marker(e.latlng).addTo(map);
      }
    });

    mapInstance.current = map;
    return () => {
      map.remove();
      mapInstance.current = null;
    };
  }, [onPick]);

  useEffect(() => {
    if (!markerPosition || !mapInstance.current) return;
    const latlng = L.latLng(markerPosition.lat, markerPosition.lng);
    if (markerRef.current) {
      markerRef.current.setLatLng(latlng);
    } else {
      markerRef.current = L.marker(latlng).addTo(mapInstance.current);
    }
  }, [markerPosition]);

  return <div ref={mapRef} style={{ width: "100%", height: "100%", borderRadius: 12 }} />;
}
