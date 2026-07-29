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
  /** 近くの別画像を探すのに使うAPIのベースURL。未指定ならその機能を出さない */
  apiUrl?: string;
}

const MAPILLARY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;
/** これ以上待っても表示されないなら静止画に切り替える */
const LOAD_TIMEOUT_MS = 12_000;

type Phase = "empty" | "loading" | "ready" | "fallback" | "failed";
type Playback = "none" | "forward" | "reverse";

export default function StreetView({ imageId, imageUrl, onReady, compact = false, apiUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  /** mapillary-js の NavigationDirection enum。動的importなのでrefに退避しておく */
  const navDirRef = useRef<any>(null);

  /** そのラウンドの開始地点。「開始地点に戻る」で使う */
  const homeIdRef = useRef("");
  /** ビューアがいま表示している画像の情報 */
  const currentRef = useRef<{ id: string; lat: number; lng: number; sequenceId: string } | null>(null);

  const [phase, setPhase] = useState<Phase>("empty");
  /** 画像タイルやメタデータを取りに行っている最中 */
  const [dataLoading, setDataLoading] = useState(false);
  /** 開始地点から動いているか */
  const [movedAway, setMovedAway] = useState(false);
  /** 360度ではない平面写真を表示している */
  const [flatImage, setFlatImage] = useState(false);
  const [playback, setPlayback] = useState<Playback>("none");
  /** 近くの別画像を検索中 */
  const [seeking, setSeeking] = useState<null | "road" | "pano" | "sharp">(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  /* mapillary-jsは拡大するほど高解像度のタイルを読み込む。
     看板を読むにはズームが要るので、ピンチだけでなくボタンでも操作できるようにする。 */
  const zoomRef = useRef(0);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((n) => (n === message ? null : n)), 2600);
  }, []);

  /* ------------------------------------------------------------------ *
   * ビューアの生成（1回だけ）
   * ------------------------------------------------------------------ */
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
          // コンストラクタにimageIdを渡すと失敗を捕捉できないので、必ずmoveToで移動する
          component: {
            cover: false,
            // 矢印(direction)と前後移動(sequence)を出す。
            // これが無いと「その場から動けない」ように見える
            direction: true,
            sequence: true,
            bearing: true,
            // ズームは自前のボタンを使うので内蔵UIは消す
            zoom: false,
            pointer: { dragPan: true, scrollZoom: true, touchZoom: true },
            keyboard: true,
          },
          // 平面写真でも隣の写真とつないで広い範囲を見回せるようにする
          combinedPanning: true,
          // 拡大したときに高解像度タイルを取りに行く。看板を読むのに必須
          imageTiling: true,
          trackResize: true,
        } as any);

        viewer.on("dataloading", (e: any) => setDataLoading(Boolean(e?.loading)));

        viewer.on("image", (e: any) => {
          const img = e?.image;
          if (!img) return;
          currentRef.current = {
            id: img.id,
            lat: img.lngLat?.lat ?? 0,
            lng: img.lngLat?.lng ?? 0,
            sequenceId: img.sequenceId ?? "",
          };
          // spherical 以外は視点を回しきれない。ユーザーに理由を伝える
          setFlatImage(img.cameraType !== "spherical");
          setMovedAway(Boolean(homeIdRef.current) && img.id !== homeIdRef.current);
        });

        try {
          const seq: any = viewer.getComponent("sequence");
          seq?.on?.("playing", (e: any) => {
            if (e && e.playing === false) setPlayback("none");
          });
        } catch {
          /* sequenceコンポーネントが無い環境 */
        }

        viewerRef.current = viewer;
      })
      .catch((err) => {
        console.error("Mapillary module load failed", err);
        setPhase(imageUrl ? "fallback" : "failed");
      });

    return () => {
      disposed = true;
    };
    // 生成は1度だけ。imageUrlは初回失敗時の表示切り替えにしか使わない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ *
   * ラウンドが変わったら、その地点へ移動する
   * ------------------------------------------------------------------ */
  useEffect(() => {
    if (!MAPILLARY_TOKEN) return;

    if (!imageId) {
      setPhase("empty");
      return;
    }

    // 前の画像の「表示済み」状態とズーム倍率を持ち越さない
    setPhase("loading");
    setPlayback("none");
    setMovedAway(false);
    zoomRef.current = 0;
    homeIdRef.current = imageId;

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

    // ビューアの生成が非同期なので、出来上がるまで少し待つ
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
      } catch {
        /* noop */
      }
      viewer
        .moveTo(imageId)
        .then(() => settle("ready"))
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
      try {
        viewerRef.current?.remove?.();
      } catch {
        /* noop */
      }
      viewerRef.current = null;
    },
    []
  );

  /* ------------------------------------------------------------------ *
   * 操作
   * ------------------------------------------------------------------ */

  const stopPlayback = useCallback(() => {
    try {
      viewerRef.current?.getComponent("sequence")?.stop?.();
    } catch {
      /* noop */
    }
    setPlayback("none");
  }, []);

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

  /** 視点だけを正面に戻す */
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

  /** 歩き回ったあとに、そのラウンドの開始地点へ戻る */
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
          applyZoom(0);
          try {
            viewer.setCenter([0.5, 0.5]);
          } catch {
            /* noop */
          }
        })
        .catch(() => {
          setPhase("ready");
          flash("開始地点に戻れませんでした");
        });
    },
    [applyZoom, flash, stopPlayback]
  );

  /** 順再生 / 逆再生。同じボタンをもう一度押すと停止 */
  const togglePlayback = useCallback(
    (e: React.MouseEvent, direction: Playback) => {
      e.stopPropagation();
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
        seq.stop?.();
        setPlayback("none");
        return;
      }

      try {
        seq.configure({ direction: direction === "forward" ? ND.Next : ND.Prev });
        seq.play?.();
        setPlayback(direction);
        flash(direction === "forward" ? "順再生します" : "逆再生します");
      } catch (err) {
        console.error("sequence playback failed", err);
        flash("この地点では再生できません");
      }
    },
    [flash, playback]
  );

  /**
   * 近くの別の画像へ移る。
   *   kind="road"  … いまと違う道／別シーケンスへ（行き止まりからの脱出）
   *   kind="pano"  … 360度で見られる写真を探す
   *   kind="sharp" … より高解像度の写真を探す（看板が読めないとき）
   */
  const jumpNearby = useCallback(
    async (e: React.MouseEvent, kind: "road" | "pano" | "sharp") => {
      e.stopPropagation();
      const current = currentRef.current;
      if (!apiUrl || !current) return;

      stopPlayback();
      setSeeking(kind);
      try {
        const params = new URLSearchParams({
          lat: String(current.lat),
          lng: String(current.lng),
          exclude: current.id,
        });
        if (kind === "pano") {
          params.set("pano", "1");
        } else if (kind === "sharp") {
          // 5760px = Insta360 X3 / GoPro Max クラス。看板がはっきり読める解像度
          params.set("minWidth", "5760");
        } else {
          if (current.sequenceId) params.set("excludeSeq", current.sequenceId);
          params.set("minKm", "0.05"); // 50m以上離れた場所を選ぶ
        }

        const messages = {
          pano: ["360度の写真に移動しました", "近くに360度写真がありません"],
          sharp: ["より鮮明な写真に移動しました", "近くにこれ以上鮮明な写真がありません"],
          road: ["近くの別の道に移動しました", "近くに別の道が見つかりません"],
        } as const;

        const res = await fetch(`${apiUrl}/nearby-image?${params.toString()}`);
        const data = await res.json();
        if (data?.found && data.imageId && data.imageId !== current.id) {
          await viewerRef.current?.moveTo(data.imageId);
          flash(messages[kind][0]);
        } else {
          flash(messages[kind][1]);
        }
      } catch {
        flash("画像の検索に失敗しました");
      } finally {
        setSeeking(null);
      }
    },
    [apiUrl, flash, stopPlayback]
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

  const showControls = phase === "ready" && !compact;

  return (
    <div className="street-wrap">
      <div
        ref={containerRef}
        className="street-canvas"
        style={{ visibility: phase === "ready" ? "visible" : "hidden" }}
      />

      {/* 読み込み中は上端に細いバーを出す。画面が固まったのか読み込み中なのかが一目で分かる */}
      {(dataLoading || seeking !== null) && phase === "ready" && <span className="street-progress" aria-hidden="true" />}

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

      {notice && (
        <div className="street-notice" role="status">
          {notice}
        </div>
      )}

      {/* 平面写真のときだけ、その理由と逃げ道を案内する */}
      {showControls && flatImage && (
        <div className="street-flat-note">
          <span>この写真は平面のため、真後ろまでは振り向けません</span>
          {apiUrl && (
            <button type="button" onClick={(e) => jumpNearby(e, "pano")} disabled={seeking !== null}>
              {seeking === "pano" ? "探しています…" : "360°写真を探す"}
            </button>
          )}
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
          <button type="button" className="street-btn is-wide" onClick={resetView}>
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

      {/* 再生系は下段にまとめる。逆再生＝来た道を戻る */}
      {showControls && (
        <div className="street-playback">
          <button
            type="button"
            className={`street-btn is-wide${playback === "reverse" ? " is-on" : ""}`}
            onClick={(e) => togglePlayback(e, "reverse")}
            aria-pressed={playback === "reverse"}
            title="来た道を逆再生します"
          >
            {playback === "reverse" ? "■ 停止" : "◀◀ 逆再生"}
          </button>
          <button
            type="button"
            className={`street-btn is-wide${playback === "forward" ? " is-on" : ""}`}
            onClick={(e) => togglePlayback(e, "forward")}
            aria-pressed={playback === "forward"}
            title="道なりに順再生します"
          >
            {playback === "forward" ? "■ 停止" : "▶▶ 順再生"}
          </button>
          {apiUrl && (
            <button
              type="button"
              className="street-btn is-wide"
              onClick={(e) => jumpNearby(e, "road")}
              disabled={seeking !== null}
              title="行き止まりのときは近くの別の道へ移ります"
            >
              {seeking === "road" ? "探索中…" : "別の道へ"}
            </button>
          )}
          {apiUrl && (
            <button
              type="button"
              className="street-btn is-wide"
              onClick={(e) => jumpNearby(e, "sharp")}
              disabled={seeking !== null}
              title="看板が読めないときは、近くのより高解像度な写真を探します"
            >
              {seeking === "sharp" ? "探索中…" : "鮮明な写真"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}