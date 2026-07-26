import { useEffect, useRef } from "react";
import { Viewer } from "mapillary-js";
import "mapillary-js/dist/mapillary.css";

interface Props {
  imageId: string;
  imageMissing: boolean;
}

const MAPILLARY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN;

// mapillary-jsで実際に操作できる360度ストリートビューを表示する。
// imageIdが無い(=その地点にMapillaryの撮影データが無かった)場合は
// ヒントだけで推理してもらう旨を表示する。
export default function StreetView({ imageId, imageMissing }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  useEffect(() => {
  if (!containerRef.current || !imageId) return;

  viewerRef.current?.remove();

  viewerRef.current = new Viewer({
    accessToken: MAPILLARY_TOKEN,
    container: containerRef.current,
    imageId,
  });

  return () => {
    viewerRef.current?.remove();
    viewerRef.current = null;
  };

}, [imageId]);

  useEffect(() => {
    if (viewerRef.current && imageId) {
      viewerRef.current.moveTo(imageId).catch((err) => console.error("moveTo failed", err));
    }
  }, [imageId]);

  if (imageMissing) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#1c1c1c",
          color: "#ddd",
          gap: 8,
          textAlign: "center",
          padding: 16,
        }}
      >
        <span style={{ fontSize: 28 }}>📍</span>
        <p style={{ margin: 0, fontSize: 14 }}>この地点の画像は見つかりませんでした</p>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>ヒントだけで推理してください</p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      {!imageId && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ccc",
            fontSize: 13,
            zIndex: 1,
          }}
        >
          画像を読み込み中...
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
