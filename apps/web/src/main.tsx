import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// CDN(unpkg)から読み込むとオフラインで地図が崩れるため、バンドルに含める
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { registerPwa } from "./lib/registerPwa";

/**
 * 広告枠の高さを実測して、余白を残さないようにする。
 *
 * CSSで高さを固定で予約すると、広告が小さい／配信されないときに
 * その差分が黒い空白として残る。ここで実寸に合わせる。
 *
 * PC枠については「枠が見えているのに中身が空」なのか
 * 「枠ごと消えている」のかを切り分けられるよう、
 * 配信の有無を data 属性に出しておく（DevToolsで確認できる）。
 */
function trackAdSlot(barSelector: string, slotSelector: string) {
  const bar = document.querySelector<HTMLElement>(barSelector);
  if (!bar) return;
  const slot = bar.querySelector<HTMLElement>(slotSelector) ?? bar;

  const apply = () => {
    // 畳んだ状態のままだと中身を測れないので、いったん元に戻してから測る
    bar.classList.remove("is-empty");
    const contentHeight = Math.max(slot.scrollHeight, Math.round(slot.getBoundingClientRect().height));
    const filled = contentHeight >= 8;
    bar.classList.toggle("is-empty", !filled);
    bar.dataset.adFilled = filled ? "yes" : "no";
    bar.dataset.adHeight = String(contentHeight);

    if (barSelector === ".ad-bar") {
      const barHeight = filled ? Math.round(bar.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--ad-h", `${barHeight}px`);
    }
  };

  apply();

  // 広告は遅れて差し込まれるので、DOMとサイズの両方を監視する
  if ("ResizeObserver" in window) new ResizeObserver(apply).observe(slot);
  new MutationObserver(apply).observe(slot, { childList: true, subtree: true, attributes: true });

  // 監視で拾えない環境向けの保険
  [300, 1000, 2500, 5000, 9000].forEach((ms) => window.setTimeout(apply, ms));
  window.addEventListener("orientationchange", () => window.setTimeout(apply, 300));
  window.addEventListener("resize", () => window.setTimeout(apply, 150));
}

function trackAds() {
  // スマホ用の下部バー
  trackAdSlot(".ad-bar", "#ad-sp");
  // PC用の右下レクタングル。中身が入らなければ枠ごと畳む
  trackAdSlot("#ad-pc-rect", "#ad-pc-rect");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

trackAds();
registerPwa();