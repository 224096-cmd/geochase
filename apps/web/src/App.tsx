import { useCallback, useEffect, useRef, useState } from "react";
import MapView from "./components/MapView";
import StreetView from "./components/StreetView";

const API_URL = import.meta.env.VITE_API_URL as string;
const WS_URL = API_URL.replace(/^http/, "ws");

type Mode = "classic" | "chase";

type RegionKey = "tokyo" | "osaka_kyoto" | "hokkaido" | "kyushu" | "japan_wide" | "world";

const REGION_OPTIONS: { key: RegionKey; label: string }[] = [
  { key: "tokyo", label: "東京近郊" },
  { key: "osaka_kyoto", label: "大阪・京都近郊" },
  { key: "hokkaido", label: "北海道" },
  { key: "kyushu", label: "九州" },
  { key: "japan_wide", label: "日本全国" },
  { key: "world", label: "世界" },
];

interface ChaseState {
  round: number;
  maxRounds: number;

  imageUrl: string;
  imageId: string;
  imageMissing: boolean;

  hint: string;
  revealedHints: string[];

  region: RegionKey;

  status: "idle" | "running" | "finished";

  secondsUntilNext: number;
}

interface GuessResult {
  distanceKm: number;
  correct: boolean;
  score: number;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("chase");
  const [roomId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [region, setRegion] = useState<RegionKey>("japan_wide");
  const [state, setState] = useState<ChaseState | null>(null);
  const [guessPin, setGuessPin] = useState<{ lat: number; lng: number } | null>(null);
  const [result, setResult] = useState<GuessResult | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (mode !== "chase") return;

    const ws = new WebSocket(`${WS_URL}/room/${roomId}/ws`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        setState(msg);
        setResult(null);
      }
      if (msg.type === "result") setResult(msg);
      if (msg.type === "caught") setResult((r) => (r ? { ...r, correct: true } : r));
    };

    return () => ws.close();
  }, [mode, roomId]);

  const startChase = useCallback(async () => {
    setGuessPin(null);
    setResult(null);
    await fetch(`${API_URL}/room/${roomId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region }),
    });
  }, [roomId, region]);

  const submitGuess = useCallback(() => {
    if (!guessPin || !wsRef.current) return;
    wsRef.current.send(
      JSON.stringify({ type: "guess", lat: guessPin.lat, lng: guessPin.lng, userId: roomId })
    );
  }, [guessPin, roomId]);

  const handleMapPick = useCallback((lat: number, lng: number) => {
  setGuessPin({ lat, lng });
}, []);

  const isRunning = state?.status === "running";
  const isFinished = state?.status === "finished";

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>GeoChase</h1>
        <div className="mode-tabs">
          <button className={mode === "classic" ? "active" : ""} onClick={() => setMode("classic")}>
            通常モード
          </button>
          <button className={mode === "chase" ? "active" : ""} onClick={() => setMode("chase")}>
            AI逃走モード
          </button>
        </div>
      </header>

      {mode === "chase" && (
        <>
          <div className="control-bar">
            <label className="region-select">
              捜索範囲
              <select value={region} onChange={(e) => setRegion(e.target.value as RegionKey)} disabled={isRunning}>
                {REGION_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="start-btn" onClick={startChase} disabled={!connected}>
              {state ? "リスタート" : "ゲーム開始"}
            </button>
          </div>

          {state && (
            <div className="status-bar">
              <span className="pill">
                ラウンド {state.round} / {state.maxRounds}
              </span>
              <span className="pill accent">次の更新まで {state.secondsUntilNext}秒</span>
              {isFinished && <span className="pill success">ゲーム終了</span>}
            </div>
          )}

          {state && state.revealedHints.length > 0 && (
            <div className="hint-row">
              {state.revealedHints.map((h, i) => (
                <span key={i} className="hint-chip">
                  {h}
                </span>
              ))}
            </div>
          )}

          {result && (
            <div className={`result-banner ${result.correct ? "correct" : "wrong"}`}>
              {result.correct
                ? `特定成功！ スコア ${result.score}`
                : `外れ（距離 約${result.distanceKm}km） スコア ${result.score}`}
            </div>
          )}
        </>
      )}

      <main className="stage">
        <section className="pane street-pane">
          {mode === "chase" ? (
            <StreetView imageId={state?.imageId ?? ""} imageMissing={state?.imageMissing ?? false} />
          ) : (
            <div className="placeholder">通常モードは準備中です</div>
          )}
        </section>

        <section className="pane map-pane">
        <MapView
          onPick={handleMapPick}
          markerPosition={guessPin}
       />
     </section>
      </main>

      <footer className="app-footer">
        <button className="guess-btn" onClick={submitGuess} disabled={!guessPin || !isRunning}>
          {guessPin ? "推理を確定" : "地図をタップしてピンを立てる"}
        </button>
      </footer>
    </div>
  );
}
