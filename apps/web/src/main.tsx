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
 * frameSelector … 畳む対象の外枠
 * slotSelector  … 広告スクリプトが中身を差し込む内側の箱（必ず外枠と別要素にする）
 * cssVar        … 実測した高さを入れるCSS変数（不要なら省略）
 *
 * 注意:
 *   外枠と内側に同じ要素を指定してはいけない。
 *   apply() は外枠の class と data 属性を書き換えるので、
 *   その要素自身を attributes 付きで監視すると無限ループになる。
 *   （実際にこれで画面が固まる不具合を出した）
 */
function trackAdSlot(frameSelector: string, slotSelector: string, cssVar?: string) {
  const frame = document.querySelector<HTMLElement>(frameSelector);
  const slot = document.querySelector<HTMLElement>(slotSelector);
  if (!frame || !slot || frame === slot) return;

  let scheduled = false;

  const apply = () => {
    // 1フレームに1回だけ動かす。連続した変更で何度も走らせない
    if (scheduled) return;
    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;

      // 測るのは内側の箱。外枠を畳んでも内側の高さは変わらないので、
      // 「いったんclassを外して測る」といった小細工が要らない
      const contentHeight = Math.max(slot.scrollHeight, Math.round(slot.getBoundingClientRect().height));
      const filled = contentHeight >= 8; // 8px未満は「配信なし」とみなす

      // 値が変わったときだけ書く。毎回書くと監視が再発火する
      if (frame.classList.contains("is-empty") === filled) {
        frame.classList.toggle("is-empty", !filled);
      }
      const flag = filled ? "yes" : "no";
      if (frame.dataset.adFilled !== flag) frame.dataset.adFilled = flag;

      if (cssVar) {
        const px = filled ? Math.round(frame.getBoundingClientRect().height) : 0;
        document.documentElement.style.setProperty(cssVar, `${px}px`);
      }
    });
  };

  apply();

  // 広告は遅れて差し込まれるので、中身の増減とサイズ変化を監視する。
  // attributes は監視しない（自分で付け外しするクラスで再発火するため）
  if ("ResizeObserver" in window) new ResizeObserver(apply).observe(slot);
  new MutationObserver(apply).observe(slot, { childList: true, subtree: true });

  // 監視で拾えない環境向けの保険
  [300, 1000, 2500, 5000, 9000].forEach((ms) => window.setTimeout(apply, ms));
  window.addEventListener("orientationchange", () => window.setTimeout(apply, 300));
  window.addEventListener("resize", () => window.setTimeout(apply, 150));
}

function trackAds() {
  // スマホ用の下部バー。高さを --ad-h に流してトーストの位置に使う
  trackAdSlot(".ad-bar", "#ad-sp", "--ad-h");
  // PC用の右下レクタングル。中身が入らなければ枠ごと畳む
  trackAdSlot("#ad-pc-rect", "#ad-pc-slot");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

trackAds();
registerPwa();