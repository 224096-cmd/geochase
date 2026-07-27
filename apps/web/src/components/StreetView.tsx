import { useCallback, useEffect, useRef, useState } from "react";
import "mapillary-js/dist/mapillary.css";

interface Props {
  imageId: string;
  /** mapillary-jsが失敗したときに表示する静止画URL */
  imageUrl?: string;
  /** 画像が見えるようになったら呼ばれる */
  onReady?: () => void;
  /** 小窓表示中。操作系を隠す */
  compact?: boolean;
}

const MAPILLARY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;
/** これ以上待っても表示されないなら静止画に切り替える */
const LOAD_TIMEOUT_MS = 12_000;

type Phase = "empty" | "loading" | "ready" | "fallback" | "failed";

export default function StreetView({ imageId, imageUrl, onReady, compact = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [phase, setPhase] = useState<Phase>("empty");

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  /* mapillary-jsは拡大するほど高解像度のタイルを読み込む。
     看板を読むにはズームが要るので、ピンチだけでなくボタンでも操作できるようにする。 */
  const zoomRef = useRef(0);

  useEffect(() => {
    if (!MAPILLARY_TOKEN || !containerRef.current) return;

    if (!imageId) {
      setPhase("empty");
      return;
    }

    // 前の画像の「表示済み」状態とズーム倍率を持ち越さない
    setPhase("loading");
    zoomRef.current = 0;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      // 表示できなくてもゲーム進行を止めないよう、静止画に切り替えて先へ進める
      setPhase(imageUrl ? "fallback" : "failed");
      onReadyRef.current?.();
    }, LOAD_TIMEOUT_MS);

    const settle = (next: Phase) => {
      if (cancelled) return;
      window.clearTimeout(timer);
      setPhase(next);
      onReadyRef.current?.();
    };

    import("mapillary-js")
      .then(({ Viewer }) => {
        if (cancelled || !containerRef.current) return;

        if (!viewerRef.current) {
          viewerRef.current = new Viewer({
            accessToken: MAPILLARY_TOKEN,
            container: containerRef.current,
            // コンストラクタにimageIdを渡すと失敗を捕捉できないので、必ずmoveToで移動する
            component: { cover: false },
          });
        }

        return viewerRef.current
          .moveTo(imageId)
          .then(() => settle("ready"))
          .catch((err: unknown) => {
            console.error("Mapillary moveTo failed", err);
            settle(imageUrl ? "fallback" : "failed");
          });
      })
      .catch((err) => {
        console.error("Mapillary module load failed", err);
        settle(imageUrl ? "fallback" : "failed");
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [imageId, imageUrl]);

  /* 小窓⇔全画面でコンテナのサイズが変わるので、ビューアに再計測させる */
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        viewerRef.current?.resize?.();
      } catch {
        /* 未初期化 */
      }
    }, 260);
    return () => window.clearTimeout(t);
  }, [compact]);

  useEffect(
    () => () => {
      viewerRef.current?.remove?.();
      viewerRef.current = null;
    },
    []
  );

  const applyZoom = useCallback((next: number) => {
    zoomRef.current = Math.max(0, Math.min(4, next));
    try {
      viewerRef.current?.setZoom(zoomRef.current);
    } catch {
      /* 未初期化 */
    }
  }, []);

  const zoomIn = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      applyZoom(zoomRef.current + 0.7);
    },
    [applyZoom]
  );

  const zoomOut = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      applyZoom(zoomRef.current - 0.7);
    },
    [applyZoom]
  );

  const resetView = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        viewerRef.current?.setCenter([0.5, 0.5]);
      } catch {
        /* 未初期化 */
      }
      applyZoom(0);
    },
    [applyZoom]
  );

  if (!MAPILLARY_TOKEN) {
    return (
      <div className="street-message">
        <p className="street-message-title">ストリート画像トークンが未設定です</p>
        <p>
          <code>apps/web/.env</code> と Cloudflare Pages の環境変数に <code>VITE_MAPILLARY_TOKEN</code> を追加してください。
        </p>
      </div>
    );
  }

  return (
    <div className="street-wrap">
      <div
        ref={containerRef}
        className="street-canvas"
        style={{ visibility: phase === "ready" ? "visible" : "hidden" }}
      />

      {phase === "fallback" && imageUrl && <img className="street-fallback" src={imageUrl} alt="現在地のストリート画像" />}

      {phase === "loading" && (
        <div className="street-message">
          <span className="street-spinner" aria-hidden="true" />
          <p>画像を読み込んでいます</p>
        </div>
      )}

      {phase === "empty" && (
        <div className="street-message">
          <p>スタートすると、ここに現地の風景が出ます</p>
        </div>
      )}

      {phase === "failed" && (
        <div className="street-message">
          <p className="street-message-title">画像を取得できませんでした</p>
          <p>この地点には見られる画像がありません。地図とヒントで推理してください。</p>
        </div>
      )}

      {phase === "ready" && !compact && (
        <div className="street-controls">
          <button type="button" className="street-btn" onClick={zoomIn} aria-label="拡大">
            ＋
          </button>
          <button type="button" className="street-btn" onClick={zoomOut} aria-label="縮小">
            −
          </button>
          <button type="button" className="street-btn is-wide" onClick={resetView}>
            戻す
          </button>
        </div>
      )}
    </div>
  );
}