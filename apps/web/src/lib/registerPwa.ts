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
    },
  });
}