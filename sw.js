/* 通知を出すためだけのサービスワーカー。
   iOS のホーム画面 Web アプリでは new Notification() が使えず、
   ServiceWorkerRegistration.showNotification() しか通知経路がない。

   キャッシュは一切しない。超音波の実験中にコードを直したのに古い版が
   出てくるのが一番困るので、fetch には手を出さない設計にしている。 */

self.addEventListener('install',  e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 通知をタップしたら、開いているタブに戻す。無ければ開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const c of list){
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
