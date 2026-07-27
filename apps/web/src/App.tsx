import { useCallback, useEffect, useRef, useState } from "react";
import MapView from "./components/MapView";
import StreetView from "./components/StreetView";

const API_URL = import.meta.env.VITE_API_URL as string;
const WS_URL = API_URL.replace(/^http/, "ws");

type Mode = "classic" | "chase";
type TabKey = "game" | "hints" | "settings";

const INTERVAL_OPTIONS = [
  { seconds: 10, label: "10秒" },
  { seconds: 30, label: "30秒" },
  { seconds: 60, label: "1分" },
  { seconds: 180, label: "3分" },
  { seconds: 300, label: "5分" },
  { seconds: 600, label: "10分" },
];

const TIME_LIMIT_OPTIONS = [
  { seconds: 0, label: "制限なし" },
  { seconds: 60, label: "1分" },
  { seconds: 300, label: "5分" },
  { seconds: 600, label: "10分" },
  { seconds: 900, label: "15分" },
  { seconds: 1800, label: "30分" },
];

interface RoomState {
  mode: Mode;
  round: number;
  maxRounds: number;
  imageId: string;
  hint: string;
  revealedHints: string[];
  status: "idle" | "running" | "finished";
  region: string;
  intervalSeconds: number;
  timeLimitSeconds: number;
  secondsUntilNext: number;
  secondsElapsed: number;
}

interface GuessResult {
  distanceKm: number | null;
  correct: boolean;
  score: number;
  target?: { lat: number; lng: number };
  timeUp?: boolean;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("game");
  const [mode, setMode] = useState<Mode>("chase");
  const [roomId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [regions, setRegions] = useState<{ key: string; label: string }[]>([]);
  const [region, setRegion] = useState("japan_wide");
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [timeLimitSeconds, setTimeLimitSeconds] = useState(0);

  const [state, setState] = useState<RoomState | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [imageReady, setImageReady] = useState(false);

  const [guessPin, setGuessPin] = useState<{ lat: number; lng: number } | null>(null);
  const [result, setResult] = useState<GuessResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [focusedPane, setFocusedPane] = useState<"street" | "map">("street");
  const [streetSource, setStreetSource] = useState<"ai" | "explore">("ai");
  const [exploreImageId, setExploreImageId] = useState("");
  const [exploreLoading, setExploreLoading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/regions`)
      .then((r) => r.json())
      .then(setRegions)
      .catch(() => setRegions([{ key: "japan_wide", label: "日本全国" }]));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}/room/${roomId}/ws`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        setState((prev) => {
          if (!prev || prev.round !== msg.round || prev.status !== msg.status) {
            setImageReady(false);
            setCountdown(msg.secondsUntilNext);
            setStreetSource("ai");
          }
          return msg;
        });
        setElapsed(msg.secondsElapsed ?? 0);
        if (msg.status === "running") setResult(null);
        if (msg.status !== "running") setGuessPin(null);
      }
      if (msg.type === "result") setResult(msg);
      if (msg.type === "caught") setResult((r) => (r ? { ...r, correct: true } : r));
    };

    return () => ws.close();
  }, [roomId]);

  useEffect(() => {
    if (!state || state.mode !== "chase" || state.status !== "running" || !imageReady) return;
    const timer = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [state?.status, state?.mode, state?.round, imageReady]);

  useEffect(() => {
    if (!state || state.mode !== "classic" || state.status !== "running" || state.timeLimitSeconds <= 0) return;
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, [state?.status, state?.mode]);

  const start = useCallback(async () => {
    setGuessPin(null);
    setResult(null);
    setExploreImageId("");
    setStreetSource("ai");
    await fetch(`${API_URL}/room/${roomId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, region, intervalSeconds, timeLimitSeconds }),
    });
  }, [roomId, mode, region, intervalSeconds, timeLimitSeconds]);

  const stop = useCallback(async () => {
    await fetch(`${API_URL}/room/${roomId}/stop`, { method: "POST" });
  }, [roomId]);

  const submitGuess = useCallback(() => {
    if (!guessPin || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "guess", lat: guessPin.lat, lng: guessPin.lng, userId: roomId }));
  }, [guessPin, roomId]);

  const exploreHere = useCallback(async () => {
    if (!guessPin) return;
    setExploreLoading(true);
    try {
      const res = await fetch(`${API_URL}/nearby-image?lat=${guessPin.lat}&lng=${guessPin.lng}`);
      const data = await res.json();
      if (data?.imageId) {
        setExploreImageId(data.imageId);
        setStreetSource("explore");
        setFocusedPane("street");
      }
    } finally {
      setExploreLoading(false);
    }
  }, [guessPin]);

  const isRunning = state?.status === "running";
  const isIdle = !state || state.status === "idle";
  const mainButtonLabel = isIdle ? "スタート" : isRunning ? "ストップ" : "リスタート";
  const handleMainButton = () => (isRunning ? stop() : start());

  const remainingClassicSeconds =
    state?.mode === "classic" && state.timeLimitSeconds > 0 ? Math.max(0, state.timeLimitSeconds - elapsed) : null;

  const displayedImageId = streetSource === "ai" ? state?.imageId ?? "" : exploreImageId;

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>GeoChase</h1>
        <button className="start-btn" onClick={handleMainButton} disabled={!connected}>
          {mainButtonLabel}
        </button>
      </header>

      <nav className="top-tabs">
        <button className={activeTab === "game" ? "active" : ""} onClick={() => setActiveTab("game")}>
          ゲーム
        </button>
        <button className={activeTab === "hints" ? "active" : ""} onClick={() => setActiveTab("hints")}>
          ヒント{state && state.revealedHints.length > 0 ? ` (${state.revealedHints.length})` : ""}
        </button>
        <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>
          設定
        </button>
      </nav>

      {activeTab === "settings" && (
        <section className="settings-panel">
          <label>
            モード
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={isRunning}>
              <option value="chase">AI逃走モード</option>
              <option value="classic">通常モード</option>
            </select>
          </label>
          <label>
            捜索範囲
            <select value={region} onChange={(e) => setRegion(e.target.value)} disabled={isRunning}>
              {regions.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {mode === "chase" && (
            <label>
              AI更新間隔
              <select value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))} disabled={isRunning}>
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === "classic" && (
            <label>
              制限時間
              <select value={timeLimitSeconds} onChange={(e) => setTimeLimitSeconds(Number(e.target.value))} disabled={isRunning}>
                {TIME_LIMIT_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="settings-note">設定を変えてから上の「スタート」を押してください。</p>
        </section>
      )}

      {activeTab === "hints" && (
        <section className="hints-panel">
          {!state || state.revealedHints.length === 0 ? (
            <p className="settings-note">ゲームを開始するとヒントがここに表示されます。</p>
          ) : (
            <ul>
              {state.revealedHints.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === "game" && (
        <>
          {state && state.status !== "idle" && (
            <div className="status-bar">
              <span className="pill">
                ラウンド {state.round} / {state.maxRounds}
              </span>
              {state.mode === "chase" && <span className="pill accent">次の更新まで {imageReady ? countdown : "画像読込中"}秒</span>}
              {remainingClassicSeconds !== null && <span className="pill accent">残り時間 {remainingClassicSeconds}秒</span>}
              {state.status === "finished" && <span className="pill success">終了</span>}
            </div>
          )}

          {result && (
            <div className={`result-banner ${result.correct ? "correct" : "wrong"}`}>
              {result.timeUp
                ? "時間切れ！"
                : result.correct
                ? `特定成功！ スコア ${result.score}`
                : `距離 約${result.distanceKm}km　スコア ${result.score}`}
            </div>
          )}

          <main className="stage">
            <section className={`pane street-pane ${focusedPane === "street" ? "focused" : "pip"}`} onClick={() => setFocusedPane("street")}>
              <div className="pane-tabs">
                <span className={streetSource === "ai" ? "active" : ""} onClick={(e) => { e.stopPropagation(); setStreetSource("ai"); }}>
                  AI映像
                </span>
                {exploreImageId && (
                  <span className={streetSource === "explore" ? "active" : ""} onClick={(e) => { e.stopPropagation(); setStreetSource("explore"); }}>
                    探索
                  </span>
                )}
              </div>
              <StreetView imageId={displayedImageId} onReady={() => setImageReady(true)} />
              {focusedPane !== "street" && <div className="pip-overlay" />}
            </section>

            <section className={`pane map-pane ${focusedPane === "map" ? "focused" : "pip"}`} onClick={() => setFocusedPane("map")}>
              <MapView
                onPick={(lat, lng) => setGuessPin({ lat, lng })}
                markerPosition={guessPin}
                targetPosition={result?.target ?? null}
              />
              {focusedPane !== "map" && <div className="pip-overlay" />}
            </section>
          </main>

          <footer className="app-footer">
            {guessPin && (
              <button className="explore-btn" onClick={exploreHere} disabled={exploreLoading}>
                {exploreLoading ? "検索中..." : "この地点をストリートビューで見る"}
              </button>
            )}
            <button className="guess-btn" onClick={submitGuess} disabled={!guessPin || !isRunning}>
              {guessPin ? "推理を確定" : "地図をタップしてピンを立てる"}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}