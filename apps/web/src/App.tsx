import { useCallback, useEffect, useRef, useState } from "react";
import MapView from "./components/MapView";
import StreetView from "./components/StreetView";

const API_URL = import.meta.env.VITE_API_URL as string;
const WS_URL = API_URL.replace(/^http/, "ws");

type Mode = "classic" | "chase";

interface ChaseState {
  round: number;
  maxRounds: number;
  imageUrl: string;
  imageId: string;
  hint: string;
  revealedHints: string[];
  status: "idle" | "running" | "finished";
  secondsUntilNext: number;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("chase");
  const [roomId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [state, setState] = useState<ChaseState | null>(null);
  const [guessPin, setGuessPin] = useState<{ lat: number; lng: number } | null>(null);
  const [result, setResult] = useState<{ distanceKm: number; correct: boolean; score: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (mode !== "chase") return;

    const ws = new WebSocket(`${WS_URL}/room/${roomId}/ws`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") setState(msg);
      if (msg.type === "result") setResult(msg);
      if (msg.type === "caught") setResult((r) => (r ? { ...r, correct: true } : r));
    };

    return () => ws.close();
  }, [mode, roomId]);

  const startChase = useCallback(async () => {
    await fetch(`${API_URL}/room/${roomId}/start`, { method: "POST" });
  }, [roomId]);

  const submitGuess = useCallback(() => {
    if (!guessPin || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "guess", lat: guessPin.lat, lng: guessPin.lng, userId: roomId }));
  }, [guessPin, roomId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", gap: 8, padding: 8 }}>
        <button onClick={() => setMode("classic")} disabled={mode === "classic"}>
          通常モード
        </button>
        <button onClick={() => setMode("chase")} disabled={mode === "chase"}>
          AI逃走モード
        </button>
        {mode === "chase" && <button onClick={startChase}>ゲーム開始</button>}
      </div>

      {mode === "chase" && state && (
        <div style={{ padding: "0 8px", fontSize: 14 }}>
          <p>
            ラウンド {state.round} / {state.maxRounds}　次の更新まで {state.secondsUntilNext}秒
          </p>
          <p>ヒント: {state.revealedHints.join(" / ")}</p>
          {result && (
            <p style={{ color: result.correct ? "green" : "red" }}>
              {result.correct ? "特定成功!" : `外れ (距離 ${result.distanceKm}km)`} スコア: {result.score}
            </p>
          )}
        </div>
      )}

      <div style={{ flex: "1 1 50%", minHeight: 200 }}>
        <StreetView imageId={state?.imageId ?? ""} />
      </div>
      <div style={{ flex: "1 1 40%", minHeight: 200 }}>
        <MapView onPick={(lat, lng) => setGuessPin({ lat, lng })} markerPosition={guessPin} />
      </div>

      <div style={{ padding: 8 }}>
        <button style={{ width: "100%" }} onClick={submitGuess} disabled={!guessPin}>
          推理を確定
        </button>
      </div>
    </div>
  );
}
