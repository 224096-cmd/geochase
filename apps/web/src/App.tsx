import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView from "./components/MapView";
import StreetView from "./components/StreetView";
import InstallButton from "./components/InstallButton";
import { API_URL, useGameRoom } from "./lib/useGameRoom";
import { formatClock, formatDistance, formatScore, proximityMessage } from "./lib/format";
import type { GuessResult, LatLng, Mode, StartOptions } from "./lib/types";

type PanelKey = "settings" | "hints" | "history" | null;

const INTERVAL_OPTIONS = [
  { seconds: 15, label: "15秒" },
  { seconds: 30, label: "30秒" },
  { seconds: 60, label: "1分" },
  { seconds: 180, label: "3分" },
  { seconds: 300, label: "5分" },
  { seconds: 600, label: "10分" },
];

const TIME_LIMIT_OPTIONS = [
  { seconds: 0, label: "制限なし" },
  { seconds: 60, label: "1分" },
  { seconds: 180, label: "3分" },
  { seconds: 300, label: "5分" },
  { seconds: 600, label: "10分" },
];

const ROUND_OPTIONS = [1, 3, 5, 8, 10];

const SETTINGS_KEY = "geochase.settings.v1";
const ROOM_KEY = "geochase.room.v1";

const DEFAULT_SETTINGS: StartOptions = {
  mode: "chase",
  region: "japan_wide",
  intervalSeconds: 60,
  timeLimitSeconds: 0,
  rounds: 5,
};

/** リロードやアプリ再起動でもゲームが続くようにルームIDを保存する。?room= があればそちらを優先 */
function resolveRoomId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("room");
  if (fromUrl && /^[A-Za-z0-9_-]{4,64}$/.test(fromUrl)) {
    localStorage.setItem(ROOM_KEY, fromUrl);
    return fromUrl;
  }
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) return saved;
  const created = crypto.randomUUID().slice(0, 8);
  localStorage.setItem(ROOM_KEY, created);
  return created;
}

function loadSettings(): StartOptions {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const [roomId] = useState(resolveRoomId);
  const [settings, setSettings] = useState<StartOptions>(loadSettings);
  const [panel, setPanel] = useState<PanelKey>(null);
  const [regions, setRegions] = useState<{ key: string; label: string }[]>([]);

  const [guessPin, setGuessPin] = useState<LatLng | null>(null);
  const [result, setResult] = useState<GuessResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [focusedPane, setFocusedPane] = useState<"street" | "map">("street");
  const [streetSource, setStreetSource] = useState<"live" | "explore">("live");
  const [explore, setExplore] = useState<{ imageId: string; imageUrl: string } | null>(null);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const lastRoundKey = useRef("");

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 3200);
  }, []);

  const handleResult = useCallback(
    (r: GuessResult) => {
      setResult(r);
      if (r.correct) {
        navigator.vibrate?.([40, 60, 120]);
        setGuessPin(null);
      }
    },
    []
  );

  const handleCaught = useCallback(
    (playerName: string | null, score: number) => {
      showToast(`${playerName ?? "誰か"}が発見しました（+${formatScore(score)}）`);
    },
    [showToast]
  );

  const { state, connection, send, start, stop, serverNow } = useGameRoom({
    roomId,
    onResult: handleResult,
    onCaught: handleCaught,
  });

  /* ---- 設定の保存 ---- */
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  /* ---- 捜索範囲の一覧 ---- */
  useEffect(() => {
    if (!API_URL) return;
    fetch(`${API_URL}/regions`)
      .then((r) => r.json())
      .then((list) => Array.isArray(list) && setRegions(list))
      .catch(() => setRegions([{ key: "japan_wide", label: "日本全国" }]));
  }, []);

  /* ---- ラウンドが変わったら表示をリセット ---- */
  useEffect(() => {
    if (!state) return;
    const key = `${state.status}:${state.round}:${state.imageId}`;
    if (key === lastRoundKey.current) return;
    lastRoundKey.current = key;

    setImageReady(false);
    setStreetSource("live");
    setExplore(null);
    if (state.status === "running") {
      setResult(null);
      setGuessPin(null);
    }
  }, [state]);

  /* ---- カウントダウン用のティック。表示はサーバー時刻から計算するのでズレない ---- */
  useEffect(() => {
    const running = state?.status === "running" && (state.nextUpdateAt > 0 || state.roundEndsAt > 0);
    if (!running) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(timer);
  }, [state?.status, state?.nextUpdateAt, state?.roundEndsAt]);

  /* ---- 操作 ---- */
  const handleStart = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setGuessPin(null);
    setExplore(null);
    try {
      await start(settings);
      setPanel(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "スタートに失敗しました");
    } finally {
      setBusy(false);
    }
  }, [settings, start, showToast]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await stop();
    } finally {
      setBusy(false);
    }
  }, [stop]);

  const submitGuess = useCallback(() => {
    if (!guessPin) return;
    const ok = send({ type: "guess", lat: guessPin.lat, lng: guessPin.lng, userId: roomId });
    if (!ok) showToast("接続が切れています。復帰を待っています");
  }, [guessPin, roomId, send, showToast]);

  const requestHint = useCallback(() => {
    if (!send({ type: "hint" })) showToast("接続が切れています");
    else setPanel("hints");
  }, [send, showToast]);

  const nextRound = useCallback(() => {
    setResult(null);
    setGuessPin(null);
    send({ type: "next" });
  }, [send]);

  const exploreHere = useCallback(async () => {
    if (!guessPin) return;
    setExploreLoading(true);
    try {
      const res = await fetch(`${API_URL}/nearby-image?lat=${guessPin.lat}&lng=${guessPin.lng}`);
      const data = await res.json();
      if (data?.found && data.imageId) {
        setExplore({ imageId: data.imageId, imageUrl: data.imageUrl ?? "" });
        setStreetSource("explore");
        setFocusedPane("street");
      } else {
        showToast(data?.error ?? "この付近には画像がありません");
      }
    } catch {
      showToast("画像の検索に失敗しました");
    } finally {
      setExploreLoading(false);
    }
  }, [guessPin, showToast]);

  const shareResult = useCallback(async () => {
    if (!state) return;
    const text = `GeoChase で ${formatScore(state.totalScore)} 点（${state.mode === "chase" ? "AI逃走モード" : "通常モード"} / ${state.round}ラウンド）`;
    const url = `${window.location.origin}${window.location.pathname}`;
    try {
      if (navigator.share) await navigator.share({ title: "GeoChase", text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        showToast("結果をコピーしました");
      }
    } catch {
      /* ユーザーがキャンセルした */
    }
  }, [state, showToast]);

  /* ---- キーボード操作（PC向け） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.key === "Enter" && guessPin && state?.status === "running") {
        e.preventDefault();
        submitGuess();
      }
      if (e.key.toLowerCase() === "m") setFocusedPane((p) => (p === "street" ? "map" : "street"));
      if (e.key.toLowerCase() === "h" && state?.status === "running") requestHint();
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guessPin, state?.status, submitGuess, requestHint]);

  /* ---- 派生値 ---- */
  const isRunning = state?.status === "running";
  const isReveal = state?.status === "reveal";
  const isFinished = state?.status === "finished";
  const isIdle = !state || state.status === "idle";

  const countdown = useMemo(() => {
    void tick;
    if (!state || state.status !== "running") return null;
    const deadline = state.nextUpdateAt || state.roundEndsAt;
    if (!deadline) return null;
    const total = state.nextUpdateAt ? state.intervalSeconds * 1000 : state.timeLimitSeconds * 1000;
    const remainingMs = Math.max(0, deadline - serverNow());
    return {
      seconds: remainingMs / 1000,
      ratio: total > 0 ? Math.max(0, Math.min(1, remainingMs / total)) : 0,
      label: state.nextUpdateAt ? "次の移動まで" : "残り時間",
    };
  }, [state, serverNow, tick]);

  const displayed = streetSource === "explore" && explore ? explore : { imageId: state?.imageId ?? "", imageUrl: state?.imageUrl ?? "" };
  const targetPosition = result?.target ?? null;
  const urgency = countdown ? (countdown.ratio < 0.15 ? "critical" : countdown.ratio < 0.4 ? "warn" : "calm") : "calm";

  /* ---- 設定不備の案内 ---- */
  if (!API_URL) {
    return (
      <div className="setup-screen">
        <h1>GeoChase</h1>
        <p className="setup-title">APIの接続先が設定されていません</p>
        <p>
          <code>apps/web/.env</code> に <code>VITE_API_URL</code> を追加し、Cloudflare Pages の環境変数にも同じ値を設定してください。
        </p>
        <pre>VITE_API_URL=https://geochase-api.example.workers.dev</pre>
      </div>
    );
  }

  return (
    <div className="app" data-panel={panel ?? "none"}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">GeoChase</span>
        </div>

        <div className="topbar-meta">
          <span className={`link-dot link-${connection}`} aria-hidden="true" />
          <span className="link-label">
            {connection === "online" ? `接続中・${state?.players ?? 1}人` : connection === "connecting" ? "接続しています" : "再接続しています"}
          </span>
        </div>

        <div className="topbar-actions">
          <InstallButton />
          <button
            type="button"
            className="primary-btn"
            onClick={isRunning ? handleStop : handleStart}
            disabled={busy || connection === "offline"}
          >
            {isIdle ? "スタート" : isRunning ? "ストップ" : "もう一度"}
          </button>
        </div>
      </header>

      {/* 進行状況の計器バー */}
      {state && state.status !== "idle" && (
        <div className="readout" data-urgency={urgency}>
          <div className="readout-cell">
            <span className="readout-label">ラウンド</span>
            <span className="readout-value">
              {state.round}<span className="readout-sub">/{state.maxRounds}</span>
            </span>
          </div>
          <div className="readout-cell">
            <span className="readout-label">合計スコア</span>
            <span className="readout-value">{formatScore(state.totalScore)}</span>
          </div>
          {countdown && (
            <div className="readout-cell readout-timer">
              <span className="readout-label">{countdown.label}</span>
              <span className="readout-value">{formatClock(countdown.seconds)}</span>
              <span className="readout-bar" style={{ transform: `scaleX(${countdown.ratio})` }} />
            </div>
          )}
          {state.mode === "chase" && state.attempts > 0 && (
            <div className="readout-cell">
              <span className="readout-label">試行</span>
              <span className="readout-value">{state.attempts}</span>
            </div>
          )}
          {isFinished && <span className="badge">終了</span>}
        </div>
      )}

      {result && (
        <div className={`result ${result.correct ? "is-correct" : "is-miss"}`} role="status">
          <strong>
            {result.timeUp
              ? "時間切れ"
              : result.correct
              ? `発見！ +${formatScore(result.score)}`
              : state?.mode === "chase"
              ? proximityMessage(result.proximity, result.bearing)
              : `${formatDistance(result.distanceKm)}のずれ・${formatScore(result.score)}点`}
          </strong>
          {!result.correct && state?.mode === "chase" && result.distanceKm !== null && (
            <span className="result-sub">誤差 {formatDistance(result.distanceKm)}</span>
          )}
        </div>
      )}

      <div className="layout">
        <main className="stage" data-focus={focusedPane}>
          <section
            className="pane pane-street"
            onClick={() => setFocusedPane("street")}
            aria-label="ストリート画像"
          >
            <div className="pane-tabs">
              <button
                type="button"
                className={streetSource === "live" ? "is-active" : ""}
                onClick={(e) => {
                  e.stopPropagation();
                  setStreetSource("live");
                }}
              >
                現地映像
              </button>
              {explore && (
                <button
                  type="button"
                  className={streetSource === "explore" ? "is-active" : ""}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStreetSource("explore");
                  }}
                >
                  下見
                </button>
              )}
            </div>
            <StreetView
              imageId={displayed.imageId}
              imageUrl={displayed.imageUrl}
              onReady={() => setImageReady(true)}
            />
          </section>

          <section className="pane pane-map" onClick={() => setFocusedPane("map")} aria-label="地図">
            <MapView
              onPick={(lat, lng) => setGuessPin({ lat, lng })}
              markerPosition={guessPin}
              targetPosition={targetPosition}
              trail={state?.revealedTrail ?? []}
              locked={!isRunning}
            />
          </section>

          <button
            type="button"
            className="swap-btn"
            onClick={() => setFocusedPane((p) => (p === "street" ? "map" : "street"))}
          >
            {focusedPane === "street" ? "地図を大きく" : "映像を大きく"}
          </button>
        </main>

        <aside className="sidebar" aria-label="パネル">
          <nav className="panel-tabs">
            <button type="button" className={panel === "settings" ? "is-active" : ""} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
              設定
            </button>
            <button type="button" className={panel === "hints" ? "is-active" : ""} onClick={() => setPanel(panel === "hints" ? null : "hints")}>
              ヒント{state && state.revealedHints.length > 0 ? `・${state.revealedHints.length}` : ""}
            </button>
            <button type="button" className={panel === "history" ? "is-active" : ""} onClick={() => setPanel(panel === "history" ? null : "history")}>
              記録
            </button>
          </nav>

          <div className="panel-body">
            {panel === "settings" && (
              <section className="panel">
                <h2>ゲーム設定</h2>
                <label className="field">
                  <span>モード</span>
                  <select
                    value={settings.mode}
                    onChange={(e) => setSettings((s) => ({ ...s, mode: e.target.value as Mode }))}
                    disabled={isRunning}
                  >
                    <option value="chase">AI逃走モード</option>
                    <option value="classic">通常モード</option>
                  </select>
                </label>

                <label className="field">
                  <span>捜索範囲</span>
                  <select
                    value={settings.region}
                    onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))}
                    disabled={isRunning}
                  >
                    {regions.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>

                {settings.mode === "chase" ? (
                  <label className="field">
                    <span>AIが移動する間隔</span>
                    <select
                      value={settings.intervalSeconds}
                      onChange={(e) => setSettings((s) => ({ ...s, intervalSeconds: Number(e.target.value) }))}
                      disabled={isRunning}
                    >
                      {INTERVAL_OPTIONS.map((o) => (
                        <option key={o.seconds} value={o.seconds}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <>
                    <label className="field">
                      <span>1ラウンドの制限時間</span>
                      <select
                        value={settings.timeLimitSeconds}
                        onChange={(e) => setSettings((s) => ({ ...s, timeLimitSeconds: Number(e.target.value) }))}
                        disabled={isRunning}
                      >
                        {TIME_LIMIT_OPTIONS.map((o) => (
                          <option key={o.seconds} value={o.seconds}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>ラウンド数</span>
                      <select
                        value={settings.rounds}
                        onChange={(e) => setSettings((s) => ({ ...s, rounds: Number(e.target.value) }))}
                        disabled={isRunning}
                      >
                        {ROUND_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}ラウンド
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}

                <p className="note">設定を変えたら上の「スタート」でやり直します。</p>

                <div className="room-row">
                  <span className="note">ルームID: <code>{roomId}</code></span>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={async () => {
                      const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
                      await navigator.clipboard.writeText(url);
                      showToast("招待リンクをコピーしました");
                    }}
                  >
                    招待リンクをコピー
                  </button>
                </div>
                <p className="note">同じリンクを開いた人と同じAIを一緒に追えます。</p>
              </section>
            )}

            {panel === "hints" && (
              <section className="panel">
                <h2>ヒント</h2>
                {state && state.revealedHints.length > 0 ? (
                  <ol className="hint-list">
                    {state.revealedHints.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="note">ヒントはまだ開いていません。</p>
                )}

                {isRunning && (
                  <>
                    <button type="button" className="ghost-btn wide" onClick={requestHint} disabled={!state || state.hintsAvailable === 0}>
                      {state && state.hintsAvailable > 0 ? `次のヒントを開く（−250点）` : "これ以上ヒントはありません"}
                    </button>
                    {state && state.hintPenalty > 0 && <p className="note">このラウンドの減点: −{formatScore(state.hintPenalty)}</p>}
                  </>
                )}
              </section>
            )}

            {panel === "history" && (
              <section className="panel">
                <h2>ラウンド記録</h2>
                {state && state.history.length > 0 ? (
                  <ul className="history-list">
                    {state.history.map((h) => (
                      <li key={h.round}>
                        <span className="history-round">R{h.round}</span>
                        <span className="history-distance">{h.guess ? formatDistance(h.distanceKm) : "未回答"}</span>
                        <span className="history-score">{formatScore(h.score)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="note">まだ記録はありません。</p>
                )}
                {state && state.history.length > 0 && (
                  <button type="button" className="ghost-btn wide" onClick={shareResult}>
                    結果を共有
                  </button>
                )}
              </section>
            )}
          </div>
        </aside>
      </div>

      <footer className="actionbar">
        {isReveal ? (
          <button type="button" className="primary-btn wide" onClick={nextRound}>
            次のラウンドへ
          </button>
        ) : isFinished ? (
          <button type="button" className="primary-btn wide" onClick={handleStart} disabled={busy}>
            もう一度あそぶ（合計 {formatScore(state?.totalScore ?? 0)}点）
          </button>
        ) : (
          <>
            {guessPin && isRunning && (
              <button type="button" className="ghost-btn" onClick={exploreHere} disabled={exploreLoading}>
                {exploreLoading ? "探しています" : "この地点を下見する"}
              </button>
            )}
            <button type="button" className="primary-btn wide" onClick={submitGuess} disabled={!guessPin || !isRunning}>
              {!isRunning ? "スタートすると回答できます" : guessPin ? "ここだと回答する" : "地図をタップしてピンを置く"}
            </button>
          </>
        )}
      </footer>

      {panel && <button type="button" className="panel-scrim" aria-label="パネルを閉じる" onClick={() => setPanel(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {!imageReady && isRunning && state?.imageId && <span className="sr-only">画像を読み込んでいます</span>}
    </div>
  );
}