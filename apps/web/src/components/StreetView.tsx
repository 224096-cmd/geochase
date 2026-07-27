import { useEffect, useRef, useState } from "react";
import "mapillary-js/dist/mapillary.css";

interface Props {
  imageId: string;
  onReady?: () => void;
}

const MAPILLARY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN;

export default function StreetView({ imageId, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !imageId || !MAPILLARY_TOKEN) return;
    let cancelled = false;

    import("mapillary-js").then(({ Viewer }) => {
      if (cancelled || !containerRef.current) return;

      if (!viewerRef.current) {
        try {
          const viewer = new Viewer({
            accessToken: MAPILLARY_TOKEN,
            container: containerRef.current,
            imageId,
            component: { cover: false },
          });
          viewer.on("image", () => {
            setReady(true);
            onReady?.();
          });
          viewerRef.current = viewer;
        } catch (err) {
          console.error("Mapillary viewer init failed", err);
        }
      } else {
        viewerRef.current
          .moveTo(imageId)
          .then(() => {
            setReady(true);
            onReady?.();
          })
          .catch((err: unknown) => console.error("moveTo failed", err));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [imageId]);

  useEffect(() => {
    return () => {
      viewerRef.current?.remove?.();
      viewerRef.current = null;
    };
  }, []);

  if (!MAPILLARY_TOKEN) {
    return (
      <div className="street-loading">
        VITE_MAPILLARY_TOKENが未設定です。.envとCloudflare Pagesの環境変数を確認してください。
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      {!ready && <div className="street-loading">画像を読み込み中...</div>}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}