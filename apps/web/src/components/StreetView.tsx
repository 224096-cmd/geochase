import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import "mapillary-js/dist/mapillary.css";

export type Playback = "none" | "forward" | "reverse";

export interface StreetViewStatus {
  ready: boolean;
  playback: Playback;
  seeking: boolean;
}

export interface StreetViewHandle {
  togglePlayback: (direction: "forward" | "reverse") => void;
  jumpNearby: () => void;
}

interface Props {
  imageId: string;
  imageUrl?: string;
  compassAngle?: number | null;
  imageMissing?: boolean;
  /** 再生を自動で止めるまでの秒数。0 なら止めるまで流す */
  playLength: number;
  onReady?: () => void;
  onMove?: (lat: number, lng: number, imageId: string) => void;
  /** ツールバーのボタン表示を切り替えるために状態を親へ渡す */
  onStatusChange?: (status: StreetViewStatus) => void;
  compact?: boolean;
  apiUrl?: string;
}

const MAPILLARY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;
const LOAD_TIMEOUT_MS = 12_000;

type Phase = "empty" | "loading" | "ready" | "fallback" | "failed";

const StreetView = forwardRef<StreetViewHandle, Props>(function StreetView(
  {
    imageId,
    imageUrl,
    compassAngle,
    imageMissing = false,
    playLength,
    onReady,
    onMove,
    onStatusChange,
    compact = false,
    apiUrl,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const navDirRef = useRef<any>(null);

  const homeIdRef = useRef("");
  const currentRef = useRef<{ id: string; lat: number; lng: number; sequenceId: string } | null>(null);
  const playTimerRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("empty");
  const [dataLoading, setDataLoading] = useState(false);
  const [movedAway, setMovedAway] = useState(false);
  const [playback, setPlayback] = useState<Playback>("none");
  const [seeking, setSeeking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const playLengthRef = useRef(playLength);
  playLengthRef.current = playLength;

  const zoomRef = useRef(0);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((n) => (n === message ? null : n)), 2600);
  }, []);

  // 値が変わったときだけ親へ通知する。毎回呼ぶと再描画が循環する
  const statusKeyRef = useRef("");
  useEffect(() => {
    const ready = phase === "ready";
    const key = `${ready}:${playback}:${seeking}`;
    if (key === statusKeyRef.current) return;
    statusKeyRef.current = key;
    onStatusRef.current?.({ ready, playback, seeking });
  }, [phase, playback, seeking]);

  // basic image coordinates の [0.5, 0.5] が撮影時の正面。読み込み直後は必ずここへ戻す
  const faceForward = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      viewer.setCenter([0.5, 0.5]);
      viewer.setZoom(0);
      zoomRef.current = 0;
    } catch {}
  }, []);

  const clearPlayTimer = useCallback(() => {
    if (playTimerRef.current !== null) {
      window.clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!MAPILLARY_TOKEN || !containerRef.current) return;
    let disposed = false;

    import("mapillary-js")
      .then(({ Viewer, NavigationDirection }) => {
        if (disposed || !containerRef.current || viewerRef.current) return;
        navDirRef.current = NavigationDirection;

        const viewer = new Viewer({
          accessToken: MAPILLARY_TOKEN,
          container: containerRef.current,
          component: {
            cover: false,
            direction: true,
            sequence: true,
            bearing: true,
            // Mapillaryの画像はCC BY-SA。出所表示は消さない
            attribution: true,
            zoom: false,
            pointer: { dragPan: true, scrollZoom: true, touchZoom: true },
            keyboard: true,
          },
          combinedPanning: true,
          imageTiling: true,
          trackResize: true,
        } as any);

        viewer.on("dataloading", (e: any) => setDataLoading(Boolean(e?.loading)));

        viewer.on("image", (e: any) => {
          const img = e?.image;
          if (!img) return;
          const lat = img.lngLat?.lat ?? 0;
          const lng = img.lngLat?.lng ?? 0;
          currentRef.current = {
            id: img.id,
            lat,
            lng,
            sequenceId: img.sequenceId ?? "",
          };
          setMovedAway(Boolean(homeIdRef.current) && img.id !== homeIdRef.current);
          if (lat || lng) onMoveRef.current?.(lat, lng, img.id);
        });

        try {
          const seq: any = viewer.getComponent("sequence");
          seq?.on?.("playing", (e: any) => {
            if (e && e.playing === false) {
              setPlayback("none");
              clearPlayTimer();
            }
          });
        } catch {}

        viewerRef.current = viewer;
      })
      .catch((err) => {
        console.error("Mapillary module load failed", err);
        setPhase(imageUrl ? "fallback" : "failed");
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!MAPILLARY_TOKEN) return;

    if (!imageId) {
      setPhase(imageUrl ? "fallback" : "empty");
      return;
    }

    setPhase("loading");
    setPlayback("none");
    setMovedAway(false);
    clearPlayTimer();
    zoomRef.current = 0;
    homeIdRef.current = imageId;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setPhase(imageUrl ? "fallback" : "failed");
      onReadyRef.current?.();
    }, LOAD_TIMEOUT_MS);

    const settle = (next: Phase) => {
      if (cancelled) return;
      window.clearTimeout(timer);
      setPhase(next);
      onReadyRef.current?.();
    };

    const startAt = Date.now();
    const tryMove = () => {
      if (cancelled) return;
      const viewer = viewerRef.current;
      if (!viewer) {
        if (Date.now() - startAt > LOAD_TIMEOUT_MS) return;
        window.setTimeout(tryMove, 120);
        return;
      }
      try {
        viewer.getComponent("sequence")?.stop?.();
      } catch {}
      viewer
        .moveTo(imageId)
        .then(() => {
          faceForward();
          settle("ready");
        })
        .catch((err: unknown) => {
          console.error("Mapillary moveTo failed", err);
          settle(imageUrl ? "fallback" : "failed");
        });
    };
    tryMove();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [imageId, imageUrl, faceForward, clearPlayTimer]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        viewerRef.current?.resize?.();
      } catch {}
    }, 260);
    return () => window.clearTimeout(t);
  }, [compact]);

  useEffect(
    () => () => {
      if (playTimerRef.current !== null) window.clearTimeout(playTimerRef.current);
      try {
        viewerRef.current?.remove?.();
      } catch {}
      viewerRef.current = null;
    },
    []
  );

  const stopPlayback = useCallback(() => {
    clearPlayTimer();
    try {
      viewerRef.current?.getComponent("sequence")?.stop?.();
    } catch {}
    setPlayback("none");
  }, [clearPlayTimer]);

  const applyZoom = useCallback((next: number) => {
    zoomRef.current = Math.max(0, Math.min(4, next));
    try {
      viewerRef.current?.setZoom(zoomRef.current);
    } catch {}
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
      faceForward();
    },
    [faceForward]
  );

  const goHome = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const viewer = viewerRef.current;
      if (!viewer || !homeIdRef.current) return;
      stopPlayback();
      setPhase("loading");
      viewer
        .moveTo(homeIdRef.current)
        .then(() => {
          setPhase("ready");
          faceForward();
        })
        .catch(() => {
          setPhase("ready");
          flash("開始地点に戻れませんでした");
        });
    },
    [faceForward, flash, stopPlayback]
  );

  const togglePlayback = useCallback(
    (direction: "forward" | "reverse") => {
      const viewer = viewerRef.current;
      const ND = navDirRef.current;
      if (!viewer || !ND) return;

      let seq: any;
      try {
        seq = viewer.getComponent("sequence");
      } catch {
        return;
      }
      if (!seq) return;

      if (playback === direction) {
        stopPlayback();
        return;
      }

      try {
        clearPlayTimer();
        seq.configure({ direction: direction === "forward" ? ND.Next : ND.Prev });
        seq.play?.();
        setPlayback(direction);

        const seconds = playLengthRef.current;
        if (seconds > 0) {
          playTimerRef.current = window.setTimeout(() => {
            playTimerRef.current = null;
            try {
              viewerRef.current?.getComponent("sequence")?.stop?.();
            } catch {}
            setPlayback("none");
          }, seconds * 1000);
          flash(`${direction === "forward" ? "順再生" : "逆再生"}（${seconds}秒）`);
        } else {
          flash(direction === "forward" ? "順再生します" : "逆再生します");
        }
      } catch (err) {
        console.error("sequence playback failed", err);
        flash("この地点では再生できません");
      }
    },
    [clearPlayTimer, flash, playback, stopPlayback]
  );

  // 問い合わせは1回だけ。条件のゆるめ方はサーバー側に寄せてある。
  // それでも駄目ならビューア自身の前後移動で必ず何か動かす
  const jumpNearby = useCallback(async () => {
    const current = currentRef.current;
    if (!current || !current.lat) return;

    stopPlayback();
    setSeeking(true);

    try {
      if (apiUrl) {
        const params = new URLSearchParams({
          lat: String(current.lat),
          lng: String(current.lng),
          exclude: current.id,
          car: "1",
          minKm: "0.05",
        });
        if (current.sequenceId) params.set("excludeSeq", current.sequenceId);

        const res = await fetch(`${apiUrl}/nearby-image?${params.toString()}`);
        const data = await res.json();
        if (data?.found && data.imageId && data.imageId !== current.id) {
          await viewerRef.current?.moveTo(data.imageId);
          faceForward();
          flash("近くの別の地点に移動しました");
          return;
        }
      }

      const ND = navDirRef.current;
      const viewer = viewerRef.current;
      if (viewer && ND) {
        for (const dir of [ND.Next, ND.Prev, ND.TurnRight, ND.TurnLeft]) {
          if (dir === undefined) continue;
          try {
            await viewer.moveDir(dir);
            faceForward();
            flash("同じ道を少し進みました");
            return;
          } catch {}
        }
      }
      flash("近くにこれ以上の地点がありません");
    } catch {
      flash("画像の検索に失敗しました");
    } finally {
      setSeeking(false);
    }
  }, [apiUrl, faceForward, flash, stopPlayback]);

  useImperativeHandle(ref, () => ({ togglePlayback, jumpNearby }), [togglePlayback, jumpNearby]);

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

  const showControls = phase === "ready" && !compact;

  return (
    <div className="street-wrap">
      <div
        ref={containerRef}
        className="street-canvas"
        style={{ visibility: phase === "ready" ? "visible" : "hidden" }}
      />

      {(dataLoading || seeking) && phase === "ready" && <span className="street-progress" aria-hidden="true" />}

      {phase === "fallback" && imageUrl && (
        <>
          <img className="street-fallback" src={imageUrl} alt="現在地のストリート画像" />
          <span className="street-credit">© Mapillary（CC BY-SA）</span>
        </>
      )}

      {phase === "loading" && (
        <div className="street-message">
          <span className="street-spinner" aria-hidden="true" />
          <p>画像を読み込んでいます</p>
        </div>
      )}

      {phase === "empty" && (
        <div className="street-message">
          {imageMissing ? (
            <>
              <p className="street-message-title">この地点の写真が見つかりませんでした</p>
              <p>自動車から撮られた画像が周辺にありません。ヒントと地図で推理してください。</p>
            </>
          ) : (
            <p>スタートすると、ここに現地の風景が出ます</p>
          )}
        </div>
      )}

      {phase === "failed" && (
        <div className="street-message">
          <p className="street-message-title">画像を表示できませんでした</p>
          <p>通信が不安定か、画像の配信が止まっています。「別の道へ」で近くの地点を試せます。</p>
        </div>
      )}

      {notice && (
        <div className="street-notice" role="status">
          {notice}
        </div>
      )}

      {showControls && (
        <div className="street-controls">
          <button type="button" className="street-btn" onClick={zoomIn} aria-label="拡大">
            ＋
          </button>
          <button type="button" className="street-btn" onClick={zoomOut} aria-label="縮小">
            −
          </button>
          <button type="button" className="street-btn is-wide" onClick={resetView} title="進行方向（正面）を向きます">
            正面
          </button>
          <button
            type="button"
            className={`street-btn is-wide${movedAway ? " is-accent" : ""}`}
            onClick={goHome}
            disabled={!movedAway}
            title="このラウンドの開始地点へ戻ります"
          >
            開始地点
          </button>
        </div>
      )}
    </div>
  );
});

export default StreetView;