import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// CDN(unpkg)から読み込むとオフラインで地図が崩れるため、バンドルに含める
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { registerPwa } from "./lib/registerPwa";

/**
 * 広告バーの高さを実測して CSS 変数 --ad-h に流し込む。
 *
 * 以前は CSS で 50px を固定で予約していたため、
 *  ・広告が実際にはそれより小さい
 *  ・そもそも配信されない
 * ときに、その差分が画面下の「何もない黒い帯」として残っていた。
 * ここで実寸に合わせることで、余った高さは全部ゲーム画面に回る。
 */
function trackAdBar() {
  const bar = document.querySelector<HTMLElement>(".ad-bar");
  if (!bar) return;
  const slot = bar.querySelector<HTMLElement>("#ad-sp") ?? bar;

  const apply = () => {
    // 畳んだ状態のままだと中身を測れないので、いったん元に戻してから測る
    bar.classList.remove("is-empty");
    const contentHeight = Math.max(slot.scrollHeight, Math.round(slot.getBoundingClientRect().height));
    const empty = contentHeight < 8; // 8px未満は「配信なし」とみなす
    bar.classList.toggle("is-empty", empty);
    const barHeight = empty ? 0 : Math.round(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--ad-h", `${barHeight}px`);
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// 旧タイル提供元のキャッシュを掃除する（OSM公式・NASA GIBSは使わなくなった）
["osm-tiles", "gibs-tiles"].forEach((name) => caches?.delete?.(name).catch(() => {}));

trackAdBar();
registerPwa();

