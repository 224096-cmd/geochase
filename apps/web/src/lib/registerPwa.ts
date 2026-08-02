import { registerSW } from "virtual:pwa-register";

/**
 * Service Workerを登録し、新しいバージョンが用意できたら再読み込みを促す。
 * autoUpdateだけだと「タブを閉じるまで古いまま」になるので、
 * 明示的に更新できる導線を出しておく。
 */
export function registerPwa() {
  if (import.meta.env.DEV) return;

  const updateSW = registerSW({
    immediate: true,
    // 新版検出時は待たずに切り替える(連続デプロイ時の新旧混在を防ぐ)。
    // 進行中のゲームを壊さないよう、実リロードは onNeedRefresh 側で行う
    onRegisteredSW(_url, registration) {
      // タブを開きっぱなしでも1分ごとに新版を確認する
      if (registration) window.setInterval(() => registration.update().catch(() => {}), 60_000);
    },
    onNeedRefresh() {
      const bar = document.createElement("div");
      bar.className = "toast";
      bar.setAttribute("role", "status");
      bar.textContent = "新しいバージョンがあります ";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-btn";
      button.style.marginInlineStart = "10px";
      button.textContent = "更新する";
      button.onclick = () => updateSW(true);

      bar.appendChild(button);
      document.body.appendChild(bar);

      // 15秒後にまだ操作がなければ自動適用(古い版で遊び続ける事故の防止)
      window.setTimeout(() => updateSW(true), 15_000);
    },
  });
}