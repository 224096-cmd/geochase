import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView from "./components/MapView";
import StreetView from "./components/StreetView";
import InstallButton from "./components/InstallButton";
import { API_URL, useGameRoom } from "./lib/useGameRoom";
import { formatClock, formatDistance, formatScore, proximityMessage } from "./lib/format";
import type { GuessResult, LatLng, Mode, StartOptions } from "./lib/types";

type PanelKey = "settings" | "hints" | "history" | null;

/** サーバーの /regions が返す1件 */
interface RegionItem {
  key: string;
  label: string;
  group?: string;
}

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

/**
 * グループの並び順。ここに無いグループは末尾へ回す。
 * サーバーが group を返さない古いAPIでも、全件が「その他」に入って一覧されるだけで壊れない。
 */
const GROUP_ORDER = [
  "まとめ",
  "地方",
  "都道府県｜北海道・東北",
  "都道府県｜関東",
  "都道府県｜中部",
  "都道府県｜近畿",
  "都道府県｜中国・四国",
  "都道府県｜九州・沖縄",
  "市区町村｜東日本",
  "市区町村｜西日本",
  "海外｜アジア",
  "海外｜北米",
  "海外｜ヨーロッパ",
  "海外｜その他",
];

/**
 * この件数を下回っていたら、APIが都道府県を知らない古い版だと判断して警告を出す。
 * （地方8 + まとめ2 = 10件しか無い旧版を検出するため）
 */
const EXPECTED_REGION_COUNT = 30;

const SETTINGS_KEY = "geochase.settings.v1";
const ROOM_KEY = "geochase.room.v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/** 正解したあと、答えのピンを何ミリ秒残すか。すぐ消すと「見えなかった」になる */
const REVEAL_HOLD_MS = 5000;

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

/**
 * 900px以上（映像と地図を左右に並べる幅）かどうか。
 * 小窓かどうかの判定に使う。PCでは両方フル表示なので、
 * どちらを選んでいても操作ボタンを隠してはいけない。
 */
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

function loadSettings(): StartOptions {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const isWide = useIsWide();
  const [roomId] = useState(resolveRoomId);
  const [settings, setSettings] = useState<StartOptions>(loadSettings);
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
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const lastRoundKey = useRef("");
  const lastMoveSeen = useRef(0);
  /** 表示中の結果をエフェクト内から読むためのミラー */
  const resultRef = useRef<GuessResult | null>(null);
  resultRef.current = result;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 3200);
  }, []);

  const handleResult = useCallback((r: GuessResult) => {
    setResult(r);
    if (r.correct) {
      navigator.vibrate?.([40, 60, 120]);
      setGuessPin(null);
    }
  }, []);

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

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  /* 捜索範囲の一覧を取得する。
     一覧はサーバーの REGION_DEFS が出どころなので、
     都道府県が出ない＝APIが古いまま、という切り分けができるようにしてある。 */
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

  /* 捜索範囲をグループごとにまとめる（<optgroup>用） */
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

  /* ラウンドが変わったら表示をリセット。
     ただし正解直後の答え合わせは数秒残す（すぐ消えると何も見えないため） */
  useEffect(() => {
    if (!state) return;
    const key = `${state.status}:${state.round}:${state.imageId}`;
    if (key === lastRoundKey.current) return;
    lastRoundKey.current = key;

    setStreetSource("live");
    setExplore(null);

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

  /* 逃走者が移動したら知らせる。地図の軌跡ピンもこのタイミングで1つ増える */
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

  /* カウントダウンのティック。表示はサーバー時刻から計算するのでズレない */
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
    if (!send({ type: "guess", lat: guessPin.lat, lng: guessPin.lng, userId: roomId })) {
      showToast("接続が切れています。復帰を待っています");
    }
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
    const modeLabel = state.mode === "chase" ? "逃走モード" : "通常モード";
    const text = `GeoChase で ${formatScore(state.totalScore)} 点（${modeLabel} / ${state.round}ラウンド）`;
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
  const isMoving = Boolean(state?.moving);

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

  const displayed =
    streetSource === "explore" && explore
      ? explore
      : { imageId: state?.imageId ?? "", imageUrl: state?.imageUrl ?? "" };

  const urgency = countdown ? (countdown.ratio < 0.15 ? "critical" : countdown.ratio < 0.4 ? "warn" : "calm") : "calm";
  // 横に並べられる幅なら、どちらも主画面なので小窓扱いにしない
  const streetCompact = !isWide && focusedPane !== "street";
  const mapCompact = !isWide && focusedPane !== "map";

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
            {connection === "online"
              ? `接続中・${state?.players ?? 1}人`
              : connection === "connecting"
              ? "接続しています"
              : "再接続しています"}
          </span>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={isRunning ? handleStop : handleStart}
            disabled={busy || isMoving || connection === "offline"}
          >
            {busy ? "準備中…" : isIdle ? "スタート" : isRunning ? "ストップ" : "もう一度"}
          </button>
        </div>
      </header>

      {/* 常に同じ高さで表示する。出し入れすると画面全体がずれるため */}
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
          <span className="readout-label">合計スコア</span>
          <span className={`readout-value${state && !isIdle ? "" : " is-empty"}`}>
            {state && !isIdle ? formatScore(state.totalScore) : "—"}
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

      <div className="layout">
        <main className="stage" data-focus={focusedPane}>
          <section className="pane pane-street" onClick={() => setFocusedPane("street")} aria-label="ストリート画像">
            {streetCompact ? (
              <span className="pip-label">タップで映像を大きく</span>
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
              imageId={displayed.imageId}
              imageUrl={displayed.imageUrl}
              compact={streetCompact}
              apiUrl={API_URL}
            />
          </section>

          <section className="pane pane-map" onClick={() => setFocusedPane("map")} aria-label="地図">
            {mapCompact && <span className="pip-label">タップで地図を大きく</span>}
            <MapView
              onPick={(lat, lng) => setGuessPin({ lat, lng })}
              markerPosition={guessPin}
              targetPosition={result?.target ?? null}
              trail={state?.revealedTrail ?? []}
              locked={!isRunning || isMoving}
              compact={mapCompact}
              onExplore={guessPin && isRunning && !isMoving ? exploreHere : undefined}
              exploreLoading={exploreLoading}
            />
          </section>

          {/* 次の地点を探している間は、画面が固まったように見えないよう明示する */}
          {(isMoving || busy) && (
            <div className="stage-overlay" role="status">
              <span className="street-spinner" aria-hidden="true" />
              <strong>{busy ? "ゲームを準備しています" : "逃走者が移動しています"}</strong>
              <span>次の地点の写真を探しています。数秒かかることがあります</span>
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
        </main>

        <aside className="sidebar" aria-label="パネル">
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
                    <option value="chase">逃走モード</option>
                    <option value="classic">通常モード</option>
                  </select>
                </label>

                <label className="field">
                  <span>捜索範囲（{regions.length}件）</span>
                  <select
                    value={settings.region}
                    onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))}
                    disabled={isRunning}
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
                    範囲を絞るほどヒントは細かいところから始まります（都道府県なら市区町村から、市区町村なら座標から）。
                  </p>
                )}

                {settings.mode === "chase" ? (
                  <label className="field">
                    <span>逃走者が移動する間隔</span>
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

                <h2>ルーム</h2>
                <p className="note">
                  いまのルーム: <code>{roomId}</code>
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
                <p className="note">同じルームに入った人と、同じ逃走者を一緒に追えます。</p>

                <h2>アプリ</h2>
                <InstallButton />
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
                    <button
                      type="button"
                      className="ghost-btn wide"
                      onClick={requestHint}
                      disabled={!state || state.hintsAvailable === 0 || isMoving}
                    >
                      {state && state.hintsAvailable > 0 ? "次のヒントを開く（−250点）" : "これ以上ヒントはありません"}
                    </button>
                    {state && state.hintPenalty > 0 && (
                      <p className="note">このラウンドの減点: −{formatScore(state.hintPenalty)}</p>
                    )}
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
            {isReveal ? (
              <button type="button" className="primary-btn wide" onClick={nextRound} disabled={isMoving}>
                {isMoving ? "次の地点を探しています…" : "次のラウンドへ"}
              </button>
            ) : isFinished ? (
              <button type="button" className="primary-btn wide" onClick={handleStart} disabled={busy}>
                もう一度あそぶ（合計 {formatScore(state?.totalScore ?? 0)}点）
              </button>
            ) : (
              <button
                type="button"
                className="primary-btn wide"
                onClick={submitGuess}
                disabled={!guessPin || !isRunning || isMoving}
              >
                {isMoving
                  ? "逃走者が移動中…"
                  : !isRunning
                  ? "スタートすると回答できます"
                  : guessPin
                  ? "ここだと回答する"
                  : "地図をタップしてピンを置く"}
              </button>
            )}
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