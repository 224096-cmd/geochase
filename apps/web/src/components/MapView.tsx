import { useEffect, useRef } from "react";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// ViteでLeafletを使うと既定のマーカー画像パスが解決できず
// 「ピンが見えない/押しても反応が無いように見える」原因になるため、
// 明示的にインポートしたURLで上書きする。
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface Props {
  onPick: (lat: number, lng: number) => void;
  markerPosition?: { lat: number; lng: number } | null;
}

// 航空写真(Esri World Imagery、無料・APIキー不要。個人/小規模利用向け)
const SATELLITE_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export default function MapView({ onPick, markerPosition }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current, {
      // ダブルタップでのズームとピン設置が競合しないよう調整
      doubleClickZoom: false,
    }).setView([35.681, 139.767], 4);

    L.tileLayer(SATELLITE_TILE_URL, {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
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

    // コンテナサイズがレイアウト確定後に変わるケース(PWA/フレックスレイアウト)に対応
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(mapRef.current);
    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      resizeObserver.disconnect();
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

  return <div ref={mapRef} style={{ width: "100%", height: "100%" }} />;
}
