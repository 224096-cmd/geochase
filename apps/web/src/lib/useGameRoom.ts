import { useCallback, useEffect, useRef, useState } from "react";
import type { GuessResult, RoomState, ServerMessage, StartOptions } from "./types";

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export type ConnectionStatus = "connecting" | "online" | "offline";

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;
const PLAYER_KEY = "geochase.player.v1";

/**
 * 端末ごとに固定のプレイヤーID。
 * ルームIDを使い回すと全員が同一人物とみなされ、
 * 連打防止が全員で共有されて「1人しか回答できない」不具合になる。
 */
function resolvePlayerId(): string {
  try {
    const saved = localStorage.getItem(PLAYER_KEY);
    if (saved) return saved;
    const created = crypto.randomUUID();
    localStorage.setItem(PLAYER_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

interface Options {
  roomId: string;
  /** 順位表に出す表示名 */
  playerName: string;
  onResult: (result: GuessResult) => void;
  onCaught: (playerName: string | null, score: number) => void;
  onNotice: (message: string) => void;
  /** Search & Chase: 逃走者本人にだけ届く現在地 */
  onRunnerPos?: (position: { lat: number; lng: number }) => void;
  /** search/duel: 自分の場所決めが受理された */
  onPlaced?: () => void;
  /** duel: 自分が探すべき「相手の地点」の映像 */
  onDuelPuzzle?: (puzzle: { imageId: string; imageUrl: string; isPano: boolean; compassAngle: number | null }) => void;
}

/**
 * ゲームルームとのWebSocket接続をまとめて扱うフック。
 *  - 切断されたら指数バックオフで自動再接続する
 *  - 25秒ごとにpingを送り、中継サーバーのアイドル切断を防ぐ
 *  - サーバー時刻との差分を保持し、カウントダウンをローカル時計のズレなしで計算する
 *  - 接続時に playerId を渡し、サーバー側でホスト判定と個別の連打防止に使う
 */
export function useGameRoom({ roomId, playerName, onResult, onCaught, onNotice, onRunnerPos, onPlaced, onDuelPuzzle }: Options) {
  const [state, setState] = useState<RoomState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [playerId] = useState(resolvePlayerId);

  const wsRef = useRef<WebSocket | null>(null);
  const clockOffset = useRef(0);
  const retryCount = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const heartbeat = useRef<number | null>(null);
  const closedByUs = useRef(false);

  const handlers = useRef({ onResult, onCaught, onNotice, onRunnerPos, onPlaced, onDuelPuzzle });
  handlers.current = { onResult, onCaught, onNotice, onRunnerPos, onPlaced, onDuelPuzzle };

  // 名前は接続を張り直さずに反映したいので、refで最新値を持つ
  const nameRef = useRef(playerName);
  nameRef.current = playerName;

  // connect と scheduleReconnect が相互に呼び合うため、refを挟んで循環参照を避ける
  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    const delay = Math.min(MAX_BACKOFF_MS, 800 * 2 ** retryCount.current) + Math.random() * 400;
    retryCount.current += 1;
    retryTimer.current = window.setTimeout(() => connectRef.current(), delay);
  }, []);

  const connect = useCallback(() => {
    if (!API_URL) {
      setConnection("offline");
      return;
    }
    const q = new URLSearchParams({ pid: playerId, name: nameRef.current });
    const wsUrl = `${API_URL.replace(/^http/, "ws")}/room/${roomId}/ws?${q.toString()}`;
    setConnection((c) => (c === "online" ? c : "connecting"));

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      retryCount.current = 0;
      setConnection("online");
      heartbeat.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "state") {
        clockOffset.current = msg.serverNow - Date.now();
        setState(msg);
      } else if (msg.type === "result") {
        handlers.current.onResult(msg);
      } else if (msg.type === "caught") {
        handlers.current.onCaught(msg.playerName, msg.score);
      } else if (msg.type === "notice") {
        handlers.current.onNotice(msg.message);
      } else if (msg.type === "runner_pos") {
        handlers.current.onRunnerPos?.(msg.position);
      } else if (msg.type === "placed") {
        handlers.current.onPlaced?.();
      } else if (msg.type === "duel_puzzle") {
        handlers.current.onDuelPuzzle?.(msg);
      }
    };

    ws.onclose = () => {
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      heartbeat.current = null;
      if (closedByUs.current) return;
      setConnection("offline");
      scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }, [roomId, playerId, scheduleReconnect]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    closedByUs.current = false;
    connect();

    // スマホでアプリに戻ってきたときは即座に張り直す（バックグラウンドで切れているため）
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "sync" }));
      } else {
        retryCount.current = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      closedByUs.current = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  /* 表示名が変わったらサーバーへ伝える。接続は張り直さない */
  useEffect(() => {
    const t = window.setTimeout(() => {
      send({ type: "rename", playerName });
    }, 400);
    return () => window.clearTimeout(t);
  }, [playerName, send]);

  /** サーバーからのエラー文をそのまま拾う（ホスト以外の操作など） */
  const readError = async (res: Response, fallback: string) => {
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) return j.error;
    } catch {
      /* JSONでない */
    }
    return fallback;
  };

  const start = useCallback(
    async (options: StartOptions) => {
      const res = await fetch(`${API_URL}/room/${roomId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...options, playerId }),
      });
      if (!res.ok) throw new Error(await readError(res, `スタートに失敗しました (${res.status})`));
    },
    [roomId, playerId]
  );

  const stop = useCallback(async () => {
    const res = await fetch(`${API_URL}/room/${roomId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId }),
    });
    if (!res.ok) throw new Error(await readError(res, `ストップに失敗しました (${res.status})`));
  }, [roomId, playerId]);

  /** サーバー時刻に補正した現在時刻 */
  const serverNow = useCallback(() => Date.now() + clockOffset.current, []);

  return { state, connection, playerId, send, start, stop, serverNow };
}