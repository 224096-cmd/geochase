import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView from "./components/MapView";
import StreetView, { type StreetViewHandle, type StreetViewStatus } from "./components/StreetView";
import AdSlot from "./components/AdSlot";
import InstallButton from "./components/InstallButton";
import { API_URL, useGameRoom } from "./lib/useGameRoom";
import { formatClock, formatDistance, formatScore, proximityMessage } from "./lib/format";
import { getCredits } from "./lib/credits";
import type { GuessResult, LatLng, Mode, StartOptions } from "./lib/types";

type PanelKey = "settings" | "hints" | "rank" | "history" | null;

interface RegionItem {
  key: string;
  label: string;
  group?: string;
}

const INTERVAL_OPTIONS = [
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
  { seconds: 1800, label: "30分" },
  { seconds: 2700, label: "45分" },
];

const ROUND_OPTIONS = [1, 3, 5, 8, 10];

const PLAY_LENGTH_OPTIONS = [
  { seconds: 3, label: "3秒" },
  { seconds: 6, label: "6秒" },
  { seconds: 12, label: "12秒" },
  { seconds: 30, label: "30秒" },
  { seconds: 0, label: "止めるまで" },
];

const PLAY_LENGTH_KEY = "geochase.playLength.v1";

function loadPlayLength(): number {
  const raw = Number(localStorage.getItem(PLAY_LENGTH_KEY));
  return PLAY_LENGTH_OPTIONS.some((o) => o.seconds === raw) ? raw : 6;
}

// Mapillaryの内部再生速度（0〜1）
const SPEED_OPTIONS = [
  { value: 0.2, label: "遅い" },
  { value: 0.45, label: "ふつう" },
  { value: 0.8, label: "速い" },
];

const PLAY_SPEED_KEY = "geochase.playSpeed.v1";

function loadPlaySpeed(): number {
  const raw = Number(localStorage.getItem(PLAY_SPEED_KEY));
  return SPEED_OPTIONS.some((o) => o.value === raw) ? raw : 0.45;
}

const GROUP_ORDER = [
  "まとめ",
  "地方",
  "都道府県｜北海道・東北",
  "都道府県｜関東",
  "都道府県｜中部",
  "都道府県｜近畿",
  "都道府県｜中国・四国",
  "都道府県｜九州・沖縄",
  "海外｜アジア",
  "海外｜北米",
  "海外｜ヨーロッパ",
  "海外｜その他",
];

const EXPECTED_REGION_COUNT = 30;

const SETTINGS_KEY = "geochase.settings.v1";
const ROOM_KEY = "geochase.room.v1";
const NAME_KEY = "geochase.name.v1";
const STAGE_KEY = "geochase.stage.v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

const REVEAL_HOLD_MS = 5000;

const MIN_SPLIT = 0.25;
const MAX_SPLIT = 0.75;
const DEFAULT_SPLIT = 0.56;

type Settings = StartOptions & { runnerChoice: string };

const DEFAULT_SETTINGS: Settings = {
  mode: "chase",
  runnerChoice: "random",
  region: "japan_wide",
  intervalSeconds: 60,
  timeLimitSeconds: 0,
  rounds: 5,
};

function resolveRoomId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("room");
  if (fromUrl && ROOM_ID_PATTERN.test(fromUrl)) {
    localStorage.setItem(ROOM_KEY, fromUrl);
    return fromUrl;
  }
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) return saved;
  const created = crypto.randomUUID().slice(0, 8);
  localStorage.setItem(ROOM_KEY, created);
  return created;
}

function resolvePlayerName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
    const created = `プレイヤー${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem(NAME_KEY, created);
    return created;
  } catch {
    return "プレイヤー";
  }
}

function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    setWide(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const merged = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    // 指名は毎回選び直す(前回のルームのIDを引きずらない)
    return { ...merged, runnerChoice: "random" };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadStage(): { split: number; swapped: boolean } {
  try {
    const raw = localStorage.getItem(STAGE_KEY);
    if (!raw) return { split: DEFAULT_SPLIT, swapped: false };
    const parsed = JSON.parse(raw) as { split?: number; swapped?: boolean };
    const split =
      typeof parsed.split === "number" && Number.isFinite(parsed.split)
        ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, parsed.split))
        : DEFAULT_SPLIT;
    return { split, swapped: parsed.swapped === true };
  } catch {
    return { split: DEFAULT_SPLIT, swapped: false };
  }
}

export default function App() {
  const isWide = useIsWide();
  const [roomId] = useState(resolveRoomId);
  const [playerName, setPlayerName] = useState(resolvePlayerName);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [panel, setPanel] = useState<PanelKey>(null);
  const [regions, setRegions] = useState<RegionItem[]>([]);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [joinId, setJoinId] = useState("");

  const [guessPin, setGuessPin] = useState<LatLng | null>(null);
  const [result, setResult] = useState<GuessResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [focusedPane, setFocusedPane] = useState<"street" | "map">("street");
  const [streetSource, setStreetSource] = useState<"live" | "explore">("live");
  const [explore, setExplore] = useState<{ imageId: string; imageUrl: string } | null>(null);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [explorePin, setExplorePin] = useState<LatLng | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const initialStage = useRef(loadStage());
  // 映像と地図の左右配置。true で地図が左になる
  const [swapped, setSwapped] = useState(initialStage.current.swapped);
  const [split, setSplit] = useState(initialStage.current.split);
  const streetRef = useRef<StreetViewHandle>(null);
  const [streetStatus, setStreetStatus] = useState<StreetViewStatus>({
    ready: false,
    playback: "none",
    seeking: false,
    seq: null,
  });
  const [playLength, setPlayLength] = useState(loadPlayLength);
  const [playSpeed, setPlaySpeed] = useState(loadPlaySpeed);
  // シークバーのドラッグ中の値。確定(移動)は250msの静止後
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  // Search & Chase: 逃走者本人にだけサーバから届く現在地
  const [runnerPos, setRunnerPos] = useState<LatLng | null>(null);
  // search/duel: 自分の場所決めが受理済みか
  const [placedSelf, setPlacedSelf] = useState(false);
  // duel: 自分が探す「相手の地点」の映像
  const [duelPuzzle, setDuelPuzzle] = useState<{
    imageId: string;
    imageUrl: string;
    isPano: boolean;
    compassAngle: number | null;
  } | null>(null);
  // search: 逃走者が映像で下見している現在地(移動の候補)
  const scoutRef = useRef<{ lat: number; lng: number; imageId: string } | null>(null);
  const [scoutPos, setScoutPos] = useState<LatLng | null>(null);
  const seekTimerRef = useRef<number | null>(null);
  const onSeekInput = useCallback((idx: number) => {
    setSeekDraft(idx);
    if (seekTimerRef.current) window.clearTimeout(seekTimerRef.current);
    seekTimerRef.current = window.setTimeout(() => {
      seekTimerRef.current = null;
      streetRef.current?.seekTo(idx);
      setSeekDraft(null);
    }, 250);
  }, []);
  // 全画面モード。映像と地図だけを表示し、必要なボタンは画面端に小さく出す
  const [immersive, setImmersive] = useState(false);
  const stageRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);

  const lastRoundKey = useRef("");
  const lastMoveSeen = useRef(0);
  const lastStatus = useRef<string>("");
  const resultRef = useRef<GuessResult | null>(null);
  resultRef.current = result;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 3200);
  }, []);

  const handleResult = useCallback((r: GuessResult) => {
    setResult(r);
    if (r.correct && !r.waiting) {
      navigator.vibrate?.([40, 60, 120]);
      setGuessPin(null);
    }
  }, []);

  const handleCaught = useCallback(
    (name: string | null, score: number) => {
      showToast(`${name ?? "誰か"}が発見しました（+${formatScore(score)}）`);
    },
    [showToast]
  );

  const { state, connection, playerId, send, start, stop, serverNow } = useGameRoom({
    roomId,
    playerName,
    onResult: handleResult,
    onCaught: handleCaught,
    onNotice: showToast,
    onRunnerPos: setRunnerPos,
    onPlaced: () => setPlacedSelf(true),
    onDuelPuzzle: setDuelPuzzle,
  });

  const isHost = !state?.hostId || state.hostId === playerId;

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (playerName.trim()) localStorage.setItem(NAME_KEY, playerName.trim());
  }, [playerName]);

  useEffect(() => {
    localStorage.setItem(STAGE_KEY, JSON.stringify({ split, swapped }));
  }, [split, swapped]);

  useEffect(() => {
    localStorage.setItem(PLAY_LENGTH_KEY, String(playLength));
  }, [playLength]);

  useEffect(() => {
    localStorage.setItem(PLAY_SPEED_KEY, String(playSpeed));
  }, [playSpeed]);

  // 広告(iframe)は #root の外にあるため、bodyのクラスで隠す
  useEffect(() => {
    document.body.classList.toggle("is-immersive", immersive);
    return () => document.body.classList.remove("is-immersive");
  }, [immersive]);

  // ブラウザの全画面が(Escや戻る操作で)解除されたら、こちらのモードも揃えて戻す
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setImmersive(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleImmersive = useCallback(() => {
    setImmersive((v) => {
      const next = !v;
      if (next) {
        setPanel(null);
        // 対応ブラウザでは本当の全画面にする。iOS Safariなど非対応でもCSSだけで成立する
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!API_URL) return;
    fetch(`${API_URL}/regions`)
      .then((r) => r.json())
      .then((list) => {
        if (!Array.isArray(list) || list.length === 0) {
          setRegionError("捜索範囲の一覧を取得できませんでした。");
          return;
        }
        setRegions(list);
        setRegionError(
          list.length < EXPECTED_REGION_COUNT
            ? `APIが古い版のため、${list.length}件しか選べません。API側（apps/api）のデプロイを確認してください。`
            : null
        );
      })
      .catch(() => {
        setRegions([{ key: "japan_wide", label: "日本全国", group: "まとめ" }]);
        setRegionError("APIに接続できませんでした。捜索範囲は日本全国のみになります。");
      });
  }, []);

  const regionGroups = useMemo(() => {
    const map = new Map<string, RegionItem[]>();
    regions.forEach((r) => {
      const g = r.group ?? "その他";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    });
    return [...map.entries()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a[0]);
      const ib = GROUP_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [regions]);

  // ラウンドが変わったら表示をリセット。正解直後の答え合わせだけ数秒残す
  useEffect(() => {
    if (!state) return;
    const key = `${state.status}:${state.round}:${state.imageId}`;
    if (key === lastRoundKey.current) return;
    lastRoundKey.current = key;

    setStreetSource("live");
    setExplore(null);
    setExplorePin(null);

    if (state.status === "running") {
      setGuessPin(null);
      const shown = resultRef.current;
      if (shown?.correct) {
        window.setTimeout(() => setResult((r) => (r === shown ? null : r)), REVEAL_HOLD_MS);
      } else {
        setResult(null);
      }
    }
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (state.status === lastStatus.current) return;
    lastStatus.current = state.status;
    if (state.status === "finished") setPanel("rank");
  }, [state?.status]);

  useEffect(() => {
    if (!state?.lastMoveAt) return;
    if (lastMoveSeen.current === 0) {
      lastMoveSeen.current = state.lastMoveAt;
      return;
    }
    if (state.lastMoveAt === lastMoveSeen.current) return;
    lastMoveSeen.current = state.lastMoveAt;
    if (state.mode === "chase" && state.status === "running" && state.round > 1) {
      showToast("逃走者が移動しました。軌跡のピンが1つ増えています");
    }
  }, [state?.lastMoveAt, state?.mode, state?.status, state?.round, showToast]);

  useEffect(() => {
    const running = state?.status === "running" && (state.nextUpdateAt > 0 || state.roundEndsAt > 0);
    if (!running) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(timer);
  }, [state?.status, state?.nextUpdateAt, state?.roundEndsAt]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setGuessPin(null);
    setExplore(null);
    setExplorePin(null);
    try {
      if (settings.mode === "search" && (state?.players ?? 1) < 2) {
        showToast("Search & Chase は2人以上で遊べます（招待リンクを共有してください）");
        return;
      }
      if (settings.mode === "duel" && (state?.players ?? 1) !== 2) {
        showToast("対決モードはちょうど2人で遊びます");
        return;
      }
      const { runnerChoice, ...opts } = settings;
      if (settings.mode === "search" && runnerChoice !== "random") {
        opts.runnerId = runnerChoice;
      } else {
        delete opts.runnerId;
      }
      await start(opts);
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
    } catch (err) {
      showToast(err instanceof Error ? err.message : "ストップに失敗しました");
    } finally {
      setBusy(false);
    }
  }, [stop, showToast]);

  const submitGuess = useCallback(() => {
    if (!guessPin) return;
    if (!send({ type: "guess", lat: guessPin.lat, lng: guessPin.lng, playerName })) {
      showToast("接続が切れています。復帰を待っています");
    }
  }, [guessPin, playerName, send, showToast]);

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
      const res = await fetch(`${API_URL}/nearby-image?lat=${guessPin.lat}&lng=${guessPin.lng}&car=1&pano=1`);
      const data = await res.json();
      if (data?.found && data.imageId) {
        setExplore({ imageId: data.imageId, imageUrl: data.imageUrl ?? "" });
        setStreetSource("explore");
        if (!isWide) setFocusedPane("street");
      } else {
        showToast(data?.error ?? "この付近には車から撮影された360°画像がありません");
      }
    } catch {
      showToast("画像の検索に失敗しました");
    } finally {
      setExploreLoading(false);
    }
  }, [guessPin, isWide, showToast]);

  // 下見中は「いま見ている場所」がそのまま回答候補なので、映像が動いたらピンも動かす。
  // 現地（答えの映像）を見ているときは答えが漏れるので何もしない
  const handleStreetMove = useCallback(
    (lat: number, lng: number, imageId?: string) => {
      // Search & Chase の逃走者: 本編映像の移動＝移動先の下見
      if (
        streetSource === "live" &&
        state?.mode === "search" &&
        state.phase === "live" &&
        state.runnerId === playerId &&
        imageId
      ) {
        scoutRef.current = { lat, lng, imageId };
        setScoutPos({ lat, lng });
        return;
      }
      if (streetSource !== "explore") return;
      const next = { lat, lng };
      setExplorePin(next);
      if (state?.status === "running" && !state?.moving && !result?.waiting) {
        setGuessPin(next);
      }
    },
    [result?.waiting, state?.moving, state?.status, state?.mode, state?.phase, state?.runnerId, playerId, streetSource]
  );

  const shareResult = useCallback(async () => {
    if (!state) return;
    const me = state.scoreboard?.find((p) => p.id === playerId);
    const rank = state.scoreboard?.findIndex((p) => p.id === playerId) ?? -1;
    const modeLabel = state.mode === "chase" ? "逃走モード" : state.mode === "search" ? "Search & Chase" : state.mode === "duel" ? "対決モード" : "通常モード";
    const rankText = rank >= 0 && (state.scoreboard?.length ?? 0) > 1
      ? `（${state.scoreboard!.length}人中 ${rank + 1}位）`
      : "";
    const text = `GeoChase で ${formatScore(me?.total ?? state.totalScore)} 点${rankText}｜${modeLabel} / ${state.round}ラウンド`;
    const url = `${window.location.origin}${window.location.pathname}`;
    try {
      if (navigator.share) await navigator.share({ title: "GeoChase", text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        showToast("結果をコピーしました");
      }
    } catch {}
  }, [state, playerId, showToast]);

  const copyInvite = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("招待リンクをコピーしました");
    } catch {
      showToast(url);
    }
  }, [roomId, showToast]);

  const joinRoom = useCallback(() => {
    const id = joinId.trim();
    if (!ROOM_ID_PATTERN.test(id)) {
      showToast("ルームIDは英数字4文字以上で入力してください");
      return;
    }
    localStorage.setItem(ROOM_KEY, id);
    window.location.search = `?room=${id}`;
  }, [joinId, showToast]);

  const newRoom = useCallback(() => {
    const id = crypto.randomUUID().slice(0, 8);
    localStorage.setItem(ROOM_KEY, id);
    window.location.search = `?room=${id}`;
  }, []);

  const applySplitFromClientX = useCallback((clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    // split は常に「映像の割合」。入替中は映像が右側なので反転して解釈する
    const streetRatio = swapped ? 1 - ratio : ratio;
    setSplit(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, streetRatio)));
  }, [swapped]);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      document.body.classList.add("is-resizing");
    },
    []
  );

  const onDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      applySplitFromClientX(e.clientX);
    },
    [applySplitFromClientX]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("is-resizing");
  }, []);

  const onSplitKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSplit((s) => Math.max(MIN_SPLIT, s - 0.04));
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setSplit((s) => Math.min(MAX_SPLIT, s + 0.04));
    }
    if (e.key === "Home") {
      e.preventDefault();
      setSplit(DEFAULT_SPLIT);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.key === "Enter" && guessPin && state?.status === "running") {
        e.preventDefault();
        submitGuess();
      }
      if (e.key.toLowerCase() === "m" && !isWide) {
        setFocusedPane((p) => (p === "street" ? "map" : "street"));
      }
      if (e.key.toLowerCase() === "x" && isWide) {
        setSwapped((s) => !s);
      }
      if (e.key.toLowerCase() === "h" && state?.status === "running") requestHint();
      if (e.key.toLowerCase() === "f") toggleImmersive();
      if (e.key === "Escape") {
        if (immersive) setImmersive(false);
        else setPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guessPin, isWide, state?.status, submitGuess, requestHint, toggleImmersive, immersive]);

  const isRunning = state?.status === "running";
  const isReveal = state?.status === "reveal";
  const isFinished = state?.status === "finished";
  const isIdle = !state || state.status === "idle";
  const isMoving = Boolean(state?.moving);
  const players = state?.players ?? 1;
  const answered = state?.answered ?? 0;
  const scoreboard = state?.scoreboard ?? [];
  const waitingOthers = Boolean(result?.waiting);

  const myRank = useMemo(() => {
    const i = scoreboard.findIndex((p) => p.id === playerId);
    return i < 0 ? null : { rank: i + 1, ...scoreboard[i] };
  }, [scoreboard, playerId]);

  const countdown = useMemo(() => {
    void tick;
    if (!state || state.status !== "running") return null;
    const useInterval = state.mode === "chase" && Boolean(state.nextUpdateAt);
    const deadline = useInterval ? state.nextUpdateAt : state.roundEndsAt;
    if (!deadline) return null;
    const total = useInterval ? state.intervalSeconds * 1000 : state.timeLimitSeconds * 1000;
    const remainingMs = Math.max(0, deadline - serverNow());
    return {
      seconds: remainingMs / 1000,
      ratio: total > 0 ? Math.max(0, Math.min(1, remainingMs / total)) : 0,
      label: useInterval ? "次の移動まで" : "残り時間",
    };
  }, [state, serverNow, tick]);

  const displayed =
    streetSource === "explore" && explore
      ? explore
      : state?.mode === "duel" && duelPuzzle
      ? duelPuzzle
      : { imageId: state?.imageId ?? "", imageUrl: state?.imageUrl ?? "" };

  const isRunner = state?.mode === "search" && Boolean(state.runnerId) && state.runnerId === playerId;

  useEffect(() => {
    if (!isRunner || state?.status !== "running") setRunnerPos(null);
  }, [isRunner, state?.status, state?.round]);

  // 場所選び中は地図が主役。自分が置く番ならスマホでも地図を前面にする
  const needsToPlace =
    state?.status === "running" &&
    state.phase === "setup" &&
    ((state.mode === "duel" && !placedSelf) || (state.mode === "search" && isRunner));

  useEffect(() => {
    if (isWide) return;
    if (needsToPlace) setFocusedPane("map");
  }, [needsToPlace, isWide]);

  useEffect(() => {
    if (isWide) return;
    if (state?.phase === "live") setFocusedPane("street");
  }, [state?.phase, state?.round, isWide]);

  useEffect(() => {
    setPlacedSelf(false);
    setDuelPuzzle(null);
    setScoutPos(null);
    scoutRef.current = null;
  }, [state?.round, state?.mode, state?.status === "idle"]);

  const urgency = countdown ? (countdown.ratio < 0.15 ? "critical" : countdown.ratio < 0.4 ? "warn" : "calm") : "calm";

  // 「回答する」等のメイン操作。通常の下部バーと全画面モードのHUDで同じ挙動を共有する
  const primaryAction = useMemo(() => {
    if (isReveal) {
      return {
        onClick: nextRound,
        disabled: isMoving || !isHost,
        title: isHost ? undefined : "ホストだけが次のラウンドへ進められます",
        label: isMoving
          ? "次の地点を探しています…"
          : isHost
          ? "次のラウンドへ"
          : "ホストが次に進めるのを待っています",
      };
    }
    if (isFinished) {
      return {
        onClick: handleStart,
        disabled: busy || !isHost,
        title: undefined as string | undefined,
        label: isHost
          ? `もう一度あそぶ（あなた ${formatScore(myRank?.total ?? 0)}点）`
          : `あなた ${formatScore(myRank?.total ?? 0)}点（ホスト待ち）`,
      };
    }
    const phase = state?.phase ?? null;

    // 対決: まず両者が隠れ場所を選ぶ
    if (state?.mode === "duel" && phase === "setup") {
      if (!placedSelf) {
        return {
          onClick: () => {
            if (!guessPin) {
              showToast("地図をタップして、相手に探させる場所を選んでください");
              return;
            }
            if (!send({ type: "place", lat: guessPin.lat, lng: guessPin.lng })) showToast("接続が切れています");
          },
          disabled: isMoving,
          title: "相手はこの場所のストリートビューだけを頼りに探します",
          label: isMoving ? "確認中…" : guessPin ? "🎯 この場所を相手の問題にする" : "地図をタップして隠れ場所を選ぶ",
        };
      }
      return {
        onClick: () => {},
        disabled: true,
        label: `相手が隠れ場所を選んでいます…（${state.placedCount ?? 1}/2）`,
      };
    }

    // Search & Chase: 場所選び
    if (state?.mode === "search" && phase === "setup") {
      if (isRunner) {
        return {
          onClick: () => {
            if (!guessPin) {
              showToast("地図をタップして、隠れ場所を選んでください");
              return;
            }
            if (!send({ type: "place", lat: guessPin.lat, lng: guessPin.lng })) showToast("接続が切れています");
          },
          disabled: isMoving,
          title: "この付近の車載360°地点があなたの潜伏場所になります",
          label: isMoving ? "確認中…" : guessPin ? "🫥 この場所に隠れる" : "地図をタップして隠れ場所を選ぶ",
        };
      }
      return { onClick: () => {}, disabled: true, label: "逃走者が隠れる場所を選んでいます…" };
    }

    // Search & Chase: 逃走者は映像で下見し、間隔ごとに「いま見ている場所」へ移動
    if (isRunner && phase === "live") {
      const remainMs = Math.max(0, (state?.nextUpdateAt ?? 0) - serverNow());
      const ready = remainMs <= 0;
      return {
        onClick: () => {
          const sc = scoutRef.current;
          if (!sc) {
            showToast("映像を動かして(再生・コマ送り・シーク)移動先を決めてください");
            return;
          }
          if (!send({ type: "relocate", lat: sc.lat, lng: sc.lng, imageId: sc.imageId })) {
            showToast("接続が切れています");
          }
        },
        disabled: !isRunning || isMoving || !ready,
        title: "いま映像で見ている場所へ実際に移動します（1回2.5kmまで）",
        label: isMoving
          ? "移動中…"
          : !ready
          ? `⏳ 次の移動まで ${formatClock(remainMs / 1000)}（映像で下見）`
          : scoutPos
          ? "📍 この映像の場所へ移動する"
          : "映像を動かして移動先を決める",
      };
    }
    return {
      onClick: submitGuess,
      disabled: !guessPin || !isRunning || isMoving || waitingOthers,
      title: undefined as string | undefined,
      label: isMoving
        ? "逃走者が移動中…"
        : waitingOthers
        ? `他の人を待っています（${answered}/${state?.mode === "search" ? Math.max(1, players - 1) : players}人）`
        : !isRunning
        ? isHost
          ? "スタートすると回答できます"
          : "ホストの開始を待っています"
        : guessPin
        ? "ここだと回答する"
        : "地図をタップしてピンを置く",
    };
  }, [
    isReveal,
    isFinished,
    isMoving,
    isHost,
    busy,
    myRank,
    guessPin,
    isRunning,
    waitingOthers,
    answered,
    players,
    nextRound,
    handleStart,
    submitGuess,
    isRunner,
    state?.mode,
    state?.phase,
    state?.placedCount,
    state?.nextUpdateAt,
    placedSelf,
    scoutPos,
    serverNow,
    tick,
    send,
    showToast,
  ]);

  const streetCompact = isWide ? false : focusedPane !== "street";
  const mapCompact = isWide ? false : focusedPane !== "map";

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
    <div className={`app${immersive ? " is-immersive" : ""}`} data-panel={panel ?? "none"}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">GeoChase</span>
        </div>

        <div className="topbar-meta">
          <span className={`link-dot link-${connection}`} aria-hidden="true" />
          <button
            type="button"
            className="players-badge"
            onClick={() => setPanel(panel === "rank" ? null : "rank")}
            title={isHost ? "あなたがホストです。タップで順位表" : "タップで順位表"}
          >
            <span className="players-icon" aria-hidden="true">👥</span>
            <span className="players-count">{connection === "online" ? players : "—"}</span>
            {isHost && <span className="players-host">主</span>}
          </button>
          <span className="link-label">
            {connection === "online" ? "接続中" : connection === "connecting" ? "接続しています" : "再接続しています"}
          </span>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={isRunning ? handleStop : handleStart}
            disabled={busy || isMoving || connection === "offline" || !isHost}
            title={isHost ? undefined : "ホストだけが開始・停止できます"}
          >
            {busy ? "準備中…" : isIdle ? "スタート" : isRunning ? "ストップ" : "もう一度"}
          </button>
        </div>
      </header>

      <div className="readout" data-urgency={urgency}>
        <div className="readout-cell">
          <span className="readout-label">ラウンド</span>
          <span className={`readout-value${state && !isIdle ? "" : " is-empty"}`}>
            {state && !isIdle ? (
              <>
                {state.round}
                <span className="readout-sub">/{state.maxRounds}</span>
              </>
            ) : (
              "—"
            )}
          </span>
        </div>

        <div className="readout-cell">
          <span className="readout-label">
            {state?.mode === "classic" && isRunning ? `回答 ${answered}/${players}人` : "あなたの得点"}
          </span>
          <span className={`readout-value${state && !isIdle ? "" : " is-empty"}`}>
            {state && !isIdle ? (
              <>
                {formatScore(myRank?.total ?? 0)}
                {players > 1 && myRank && <span className="readout-sub">{myRank.rank}位</span>}
              </>
            ) : (
              "—"
            )}
          </span>
        </div>

        <div className="readout-cell readout-timer">
          <span className="readout-label">{isMoving ? "状況" : countdown?.label ?? "待機中"}</span>
          <span className={`readout-value${isMoving || countdown ? "" : " is-empty"}`}>
            {isMoving ? (
              <span className="readout-moving">
                <span className="street-spinner is-tiny" aria-hidden="true" />
                移動中
              </span>
            ) : countdown ? (
              formatClock(countdown.seconds)
            ) : (
              "—"
            )}
          </span>
          {!isMoving && countdown && (
            <span className="readout-bar" style={{ transform: `scaleX(${countdown.ratio})` }} />
          )}
        </div>
      </div>

      <div className="toolbar" role="group" aria-label="映像の操作">
        {state?.mode === "search" && state.runnerName && !isIdle && (
          <span className={`runner-chip${isRunner ? " is-me" : ""}`} title="Search & Chase の逃走役">
            👣 {isRunner ? "あなたが逃走者！" : `逃走者: ${state.runnerName}`}
          </span>
        )}
        <button
          type="button"
          className="tool-btn"
          onClick={() => streetRef.current?.step("reverse")}
          disabled={!streetStatus.ready}
          title="1コマだけ戻ります"
        >
          ｜◀
        </button>
        <button
          type="button"
          className={`tool-btn${streetStatus.playback === "reverse" ? " is-on" : ""}`}
          onClick={() => streetRef.current?.togglePlayback("reverse")}
          disabled={!streetStatus.ready}
          aria-pressed={streetStatus.playback === "reverse"}
          title="来た道を逆再生します"
        >
          {streetStatus.playback === "reverse" ? "■ 停止" : "◀◀ 逆再生"}
        </button>
        <button
          type="button"
          className={`tool-btn${streetStatus.playback === "forward" ? " is-on" : ""}`}
          onClick={() => streetRef.current?.togglePlayback("forward")}
          disabled={!streetStatus.ready}
          aria-pressed={streetStatus.playback === "forward"}
          title="道なりに順再生します"
        >
          {streetStatus.playback === "forward" ? "■ 停止" : "▶▶ 順再生"}
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={() => streetRef.current?.step("forward")}
          disabled={!streetStatus.ready}
          title="1コマだけ進みます"
        >
          ▶｜
        </button>
        <label className="tool-select">
          <span className="sr-only">再生の長さ</span>
          <select value={playLength} onChange={(e) => setPlayLength(Number(e.target.value))} title="再生の長さ">
            {PLAY_LENGTH_OPTIONS.map((o) => (
              <option key={o.seconds} value={o.seconds}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tool-select">
          <span className="sr-only">再生の速さ</span>
          <select
            value={playSpeed}
            onChange={(e) => setPlaySpeed(Number(e.target.value))}
            title="再生の速さ"
          >
            {SPEED_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                速さ: {o.label}
              </option>
            ))}
          </select>
        </label>
        {streetStatus.seq && (
          <label className="tool-seek" title="この道のどこを見るかを選べます">
            <span className="sr-only">走行ルート内の再生位置</span>
            <input
              type="range"
              min={0}
              max={streetStatus.seq.total - 1}
              step={1}
              value={seekDraft ?? streetStatus.seq.idx}
              onChange={(e) => onSeekInput(Number(e.target.value))}
              disabled={!streetStatus.ready}
            />
            <span className="tool-seek-pos">
              {(seekDraft ?? streetStatus.seq.idx) + 1}/{streetStatus.seq.total}
            </span>
          </label>
        )}
        <button
          type="button"
          className="tool-btn"
          onClick={() => streetRef.current?.jumpNearby()}
          disabled={!streetStatus.ready || streetStatus.seeking}
          title="行き止まりのときは近くの別の地点へ移ります"
        >
          {streetStatus.seeking ? "探索中…" : "別の道へ"}
        </button>
        {isWide && (
          <button
            type="button"
            className="tool-btn tool-btn-swap"
            onClick={() => setSwapped((s) => !s)}
            title="映像と地図の左右を入れ替えます（X）"
          >
            ⇄ 入替
          </button>
        )}
        <button
          type="button"
          className="tool-btn tool-btn-end"
          onClick={toggleImmersive}
          title="映像と地図だけの全画面表示に切り替えます（F）"
        >
          ⛶ 全画面
        </button>
      </div>

      <div className="layout">
        <main
          className="stage"
          ref={stageRef}
          data-focus={focusedPane}
          data-mode={isWide ? "split" : "focus"}
          style={
            {
              "--split-street": String(split),
              "--split-map": String(1 - split),
            } as React.CSSProperties
          }
        >
          <section
            className="pane pane-street"
            style={isWide ? { order: swapped ? 3 : 1 } : undefined}
            onClick={() => !isWide && setFocusedPane("street")}
            aria-label="ストリート画像"
          >
            {state?.status === "running" && state.phase === "setup" && !streetCompact && (
              <div className="setup-note" role="status">
                <strong>
                  {state.mode === "duel"
                    ? placedSelf
                      ? "相手が隠れ場所を選んでいます…"
                      : "🎯 地図をタップして「相手に探させる場所」を選ぼう"
                    : isRunner
                    ? "🫥 地図をタップして隠れ場所を選ぼう"
                    : "逃走者が隠れ場所を選んでいます…"}
                </strong>
                <span>
                  {state.mode === "duel"
                    ? placedSelf
                      ? `（${state.placedCount ?? 1}/2）そろったら対決開始！`
                      : "ピンを置いたら下のボタンで確定。相手には見えません"
                    : isRunner
                    ? "ピンを置いたら下のボタンで確定。追手には見えません"
                    : "決まると捜索が始まります"}
                </span>
              </div>
            )}
            {streetCompact ? (
              <span className="pip-label">映像 ⤢</span>
            ) : (
              explore && (
                <div className="pane-tabs">
                  <button
                    type="button"
                    className={streetSource === "live" ? "is-active" : ""}
                    onClick={(e) => {
                      e.stopPropagation();
                      setStreetSource("live");
                    }}
                  >
                    現地
                  </button>
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
                </div>
              )
            )}
            <StreetView
              ref={streetRef}
              imageId={displayed.imageId}
              imageUrl={displayed.imageUrl}
              compassAngle={(state?.mode === "duel" && duelPuzzle ? duelPuzzle.compassAngle : state?.compassAngle) ?? null}
              imageMissing={Boolean(state?.imageMissing) && streetSource === "live" && state?.phase !== "setup"}
              playLength={playLength}
              playSpeed={playSpeed}
              compact={streetCompact}
              apiUrl={API_URL}
              onMove={handleStreetMove}
              onStatusChange={setStreetStatus}
            />
          </section>

          {isWide && (
            <div
              className="stage-split"
              style={{ order: 2 }}
              role="separator"
              aria-orientation="vertical"
              aria-label="映像と地図の比率"
              aria-valuenow={Math.round(split * 100)}
              aria-valuemin={Math.round(MIN_SPLIT * 100)}
              aria-valuemax={Math.round(MAX_SPLIT * 100)}
              tabIndex={0}
              onPointerDown={startDrag}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onSplitKey}
              onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
              title="ドラッグで比率を変更／ダブルクリックで半々に戻す"
            >
              <span className="stage-split-grip" aria-hidden="true" />
            </div>
          )}

          <section
            className="pane pane-map"
            style={isWide ? { order: swapped ? 1 : 3 } : undefined}
            onClick={() => !isWide && setFocusedPane("map")}
            aria-label="地図"
          >
            {mapCompact && <span className="pip-label">地図 ⤢</span>}
            <MapView
              onPick={(lat, lng) => {
                if (isRunner && state?.phase === "live") {
                  showToast("あなたは逃走者。映像を動かして「移動」で逃げましょう");
                  return;
                }
                setGuessPin({ lat, lng });
                setExplorePin(null);
              }}
              markerPosition={guessPin}
              targetPosition={result?.target ?? null}
              trail={state?.revealedTrail ?? []}
              locked={!isRunning || isMoving || waitingOthers}
              compact={mapCompact}
              onExplore={guessPin && isRunning && !isMoving ? exploreHere : undefined}
              exploreLoading={exploreLoading}
              runnerPos={isRunner ? runnerPos : null}
              scoutPos={isRunner && state?.phase === "live" ? scoutPos : null}
              panTo={isRunner ? scoutPos ?? runnerPos : streetSource === "explore" ? explorePin : null}
            />
          </section>


          {immersive && (
            <>
              <div className="hud-chip" data-urgency={urgency} role="status">
                {state && !isIdle ? (
                  <>
                    <span className="hud-round">
                      R{state.round}/{state.maxRounds}
                    </span>
                    <span className="hud-score">{formatScore(myRank?.total ?? 0)}点</span>
                    <span className="hud-timer">
                      {isMoving ? "移動中" : countdown ? formatClock(countdown.seconds) : "—"}
                    </span>
                    {state.mode === "search" && state.runnerName && (
                      <span className="hud-runner">👣 {isRunner ? "あなたが逃走者！" : state.runnerName}</span>
                    )}
                  </>
                ) : (
                  <span className="hud-round">GeoChase</span>
                )}
              </div>
              <button
                type="button"
                className="hud-exit"
                onClick={toggleImmersive}
                title="全画面を終了します（Esc / F）"
              >
                ✕ 全画面終了
              </button>
              <div className="hud-bar">
                <button
                  type="button"
                  className={`hud-play${streetStatus.playback === "reverse" ? " is-on" : ""}`}
                  onClick={() => streetRef.current?.togglePlayback("reverse")}
                  disabled={!streetStatus.ready}
                  title="逆再生"
                >
                  {streetStatus.playback === "reverse" ? "■" : "◀◀"}
                </button>
                <button
                  type="button"
                  className={`hud-play${streetStatus.playback === "forward" ? " is-on" : ""}`}
                  onClick={() => streetRef.current?.togglePlayback("forward")}
                  disabled={!streetStatus.ready}
                  title="順再生"
                >
                  {streetStatus.playback === "forward" ? "■" : "▶▶"}
                </button>
                <button
                  type="button"
                  className="primary-btn hud-action"
                  onClick={primaryAction.onClick}
                  disabled={primaryAction.disabled}
                  title={primaryAction.title}
                >
                  {primaryAction.label}
                </button>
              </div>
            </>
          )}

          {(isMoving || busy) && (
            <div className="stage-overlay" role="status">
              <span className="street-spinner" aria-hidden="true" />
              <strong>{busy ? "ゲームを準備しています" : "逃走者が移動しています"}</strong>
              <span>次の地点の写真を探しています。数秒かかることがあります</span>
            </div>
          )}


          {result && (
            <div className={`result ${result.correct && !waitingOthers ? "is-correct" : "is-miss"}`} role="status">
              <strong>
                {waitingOthers
                  ? `回答しました。他の人を待っています（${answered}/${players}人）`
                  : result.timeUp
                  ? "時間切れ"
                  : result.correct
                  ? `発見！ +${formatScore(result.score)}`
                  : state?.mode === "chase"
                  ? proximityMessage(result.proximity, result.bearing)
                  : `${formatDistance(result.distanceKm)}のずれ・${formatScore(result.score)}点`}
              </strong>
              {!result.correct && !waitingOthers && state?.mode === "chase" && result.distanceKm !== null && (
                <span className="result-sub">誤差 {formatDistance(result.distanceKm)}</span>
              )}
            </div>
          )}
        </main>

        <aside className="sidebar" aria-label="パネル">
          <div className="panel-body">
            {panel === "settings" && (
              <section className="panel">
                <h2>プレイヤー</h2>
                <label className="field">
                  <span>表示名（順位表に出ます）</span>
                  <input
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value.slice(0, 20))}
                    placeholder="例: たろう"
                    maxLength={20}
                    autoComplete="off"
                  />
                </label>

                <h2>ゲーム設定</h2>

                {!isHost && (
                  <p className="note is-warn">
                    ホストが設定を管理しています。ホストが退室すると、次に入った人へ自動で移ります。
                  </p>
                )}

                <label className="field">
                  <span>モード</span>
                  <select
                    value={settings.mode}
                    onChange={(e) => setSettings((s) => ({ ...s, mode: e.target.value as Mode }))}
                    disabled={isRunning || !isHost}
                  >
                    <option value="chase">逃走モード（AIが逃げる）</option>
                    <option value="classic">通常モード</option>
                    <option value="search">Search &amp; Chase（1人が逃げる対戦）</option>
                    <option value="duel">対決（2人・場所を出し合う）</option>
                  </select>
                </label>

                {settings.mode === "duel" && (state?.players ?? 1) !== 2 && (
                  <p className="field-warn">⚠ 対決モードはちょうど2人で遊びます（今は{state?.players ?? 1}人）</p>
                )}

                {settings.mode === "search" && (
                  <label className="field">
                    <span>逃走者の決め方</span>
                    <select
                      value={settings.runnerChoice}
                      onChange={(e) => setSettings((s) => ({ ...s, runnerChoice: e.target.value }))}
                      disabled={isRunning || !isHost}
                    >
                      <option value="random">🎲 ランダムに選ぶ</option>
                      {(state?.roster ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          👣 {p.name ?? "名無し"}
                          {p.id === playerId ? "（あなた）" : ""}
                        </option>
                      ))}
                    </select>
                    {(state?.players ?? 1) < 2 && (
                      <span className="field-warn">⚠ 2人以上で遊べます。上の招待リンクを共有してください</span>
                    )}
                  </label>
                )}

                <label className="field">
                  <span>捜索範囲（{regions.length}件）</span>
                  <select
                    value={settings.region}
                    onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))}
                    disabled={isRunning || !isHost}
                  >
                    {regionGroups.map(([group, items]) => (
                      <optgroup key={group} label={group}>
                        {items.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                {regionError ? (
                  <p className="note is-warn">{regionError}</p>
                ) : (
                  <p className="note">
                    範囲を絞るほどヒントは細かいところから始まります（都道府県を選ぶと市区町村から）。
                    車載の360°画像が無い県では、自動でひとつ広い範囲（地方→全国）に切り替わります。
                  </p>
                )}

                {(settings.mode === "chase" || settings.mode === "search") && (
                  <label className="field">
                    <span>{settings.mode === "search" ? "逃走者が移動できる間隔" : "逃走者が移動する間隔"}</span>
                    <select
                      value={settings.intervalSeconds}
                      onChange={(e) => setSettings((s) => ({ ...s, intervalSeconds: Number(e.target.value) }))}
                      disabled={isRunning || !isHost}
                    >
                      {INTERVAL_OPTIONS.map((o) => (
                        <option key={o.seconds} value={o.seconds}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {settings.mode !== "chase" && (
                  <>
                    <label className="field">
                      <span>1ラウンドの制限時間</span>
                      <select
                        value={settings.timeLimitSeconds}
                        onChange={(e) => setSettings((s) => ({ ...s, timeLimitSeconds: Number(e.target.value) }))}
                        disabled={isRunning || !isHost}
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
                        disabled={isRunning || !isHost}
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

                <p className="note">
                  点数はピンの距離から1人ずつ別々に計算されます。全員が回答するか時間切れでラウンドが終わり、
                  最後に累計スコアの順位が出ます。
                </p>
                <p className="note">
                  <strong>Search &amp; Chase</strong>（2人以上）: 逃走者がまず地図で隠れ場所を選び、
                  以後はストリートビューの中を自由に下見しながら、設定した間隔ごとに
                  「いま見ている場所」へ実際に移動できます（1回2.5kmまで）。追手は映像から現在地を特定。
                  逃走者の得点は「追手の平均点が低いほど」高くなります。ヒントは使えません。
                </p>
                <p className="note">
                  <strong>対決</strong>（2人専用）: お互いに地図で隠れ場所を出し合い、相手が選んだ場所の
                  ストリートビューだけを頼りに探します。0.5km以内で当てたら即勝利(+1500)、
                  そうでなければ近かった方の勝ち(+800)。
                </p>
                <p className="note">設定を変えたら上の「スタート」でやり直します。</p>

          {isWide && (
                  <p className="note">
                    映像と地図のあいだの仕切りをドラッグすると比率を変えられます。
                    ダブルクリックで半々に戻ります（キーボードは ← → ）。
                    左右の入れ替えは上の操作バーの「⇄ 入替」から（キーボードは X ）。
                  </p>
                )}

                <h2>ルーム</h2>
                <p className="note">
                  いまのルーム: <code>{roomId}</code>
                  <br />
                  接続中: {players}人{isHost ? "（あなたがホスト）" : ""}
                </p>

                <label className="field">
                  <span>友達のルームIDを入れて参加</span>
                  <div className="room-join">
                    <input
                      value={joinId}
                      onChange={(e) => setJoinId(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                      placeholder="例: a1b2c3d4"
                      inputMode="text"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={64}
                    />
                    <button type="button" className="ghost-btn" onClick={joinRoom}>
                      参加
                    </button>
                  </div>
                </label>

                <button type="button" className="ghost-btn wide" onClick={copyInvite}>
                  招待リンクをコピー
                </button>
                <button type="button" className="ghost-btn wide" onClick={newRoom}>
                  新しいルームを作る
                </button>
                <p className="note">同じルームに入った人と、同じ地点を一緒に当てられます。</p>

                <h2>アプリ</h2>
                <InstallButton />
              </section>
            )}

            {panel === "rank" && (
              <section className="panel">
                <h2>{isFinished ? "最終順位" : "順位"}</h2>
                {scoreboard.length > 0 ? (
                  <ol className="rank-list">
                    {scoreboard.map((p, i) => (
                      <li key={p.id} className={p.id === playerId ? "is-me" : ""}>
                        <span className={`rank-no rank-${i + 1 <= 3 ? i + 1 : "n"}`}>{i + 1}</span>
                        <span className="rank-name">
                          {p.name ?? "名無し"}
                          {p.id === playerId && <span className="rank-you">あなた</span>}
                          {!p.online && <span className="rank-offline">離席</span>}
                        </span>
                        <span className="rank-detail">
                          {p.lastRound > 0 && <span className="rank-last">+{formatScore(p.lastRound)}</span>}
                          {p.bestKm !== null && <span className="rank-best">最短 {formatDistance(p.bestKm)}</span>}
                        </span>
                        <span className="rank-total">{formatScore(p.total)}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="note">まだ誰も回答していません。</p>
                )}

                {isFinished && (
                  <button type="button" className="ghost-btn wide" onClick={shareResult}>
                    結果を共有
                  </button>
                )}
                <p className="note">
                  点数は同じ地点でも「置いたピンがどれだけ近いか」で1人ずつ別に計算されます。
                </p>
              </section>
            )}

            {panel === "hints" && (
              <section className="panel">
                <h2>ヒント</h2>
                {state?.mode === "search" && (
                  <p className="note">Search &amp; Chase では逃走者が動くため、ヒントは使えません。</p>
                )}
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
                    <button
                      type="button"
                      className="ghost-btn wide"
                      onClick={requestHint}
                      disabled={!state || state.hintsAvailable === 0 || isMoving}
                    >
                      {state && state.hintsAvailable > 0 ? "次のヒントを開く（−250点）" : "これ以上ヒントはありません"}
                    </button>
                    {state && state.hintPenalty > 0 && (
                      <p className="note">このラウンドの減点: −{formatScore(state.hintPenalty)}（全員に適用）</p>
                    )}
                  </>
                )}
              </section>
            )}

            {panel === "history" && (
              <section className="panel">
                <h2>ラウンド記録</h2>
                <p className="note">そのラウンドで、いちばん近かった回答を載せています。</p>
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

                {/* 地図・映像に重ねていた出典表示はここへ移設。
                    OSM(ODbL)・Mapillary(CC BY-SA)等の利用条件のため、この一覧は消さないこと */}
                <h2>出典・クレジット</h2>
                <div className="credit-list">
                  {getCredits().map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              </section>
            )}

            {/* 広告はパネルを開いたときだけ本文の下に出す。
                key に panel を渡しているので、タブを切り替えるたびに次の素材へ進む。
                プレイ中に開くヒントだけは邪魔にならない小さい枠にする */}
            {panel && <AdSlot key={panel} variant={panel === "hints" ? "banner" : "rect"} />}
          </div>

          <nav className="panel-tabs">
            <button
              type="button"
              className={panel === "settings" ? "is-active" : ""}
              onClick={() => setPanel(panel === "settings" ? null : "settings")}
            >
              設定
            </button>
            <button
              type="button"
              className={panel === "rank" ? "is-active" : ""}
              onClick={() => setPanel(panel === "rank" ? null : "rank")}
            >
              順位{players > 1 && myRank ? `・${myRank.rank}位` : ""}
            </button>
            <button
              type="button"
              className={panel === "hints" ? "is-active" : ""}
              onClick={() => setPanel(panel === "hints" ? null : "hints")}
            >
              ヒント{state && state.revealedHints.length > 0 ? `・${state.revealedHints.length}` : ""}
            </button>
            <button
              type="button"
              className={panel === "history" ? "is-active" : ""}
              onClick={() => setPanel(panel === "history" ? null : "history")}
            >
              記録
            </button>
          </nav>

          <footer className="actionbar">
            <button
              type="button"
              className="primary-btn wide"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              title={primaryAction.title}
            >
              {primaryAction.label}
            </button>
          </footer>
        </aside>
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}