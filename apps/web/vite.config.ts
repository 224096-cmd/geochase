import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    // 同じWi-Fiのスマホから http://<PCのIP>:5173 で実機確認できるようにする
    host: true,
    port: 5173,
  },
  build: {
    target: "es2020",
    sourcemap: false,
    rollupOptions: {
      output: {
        // mapillary-jsとleafletは重いので初期表示のJSから切り離す
        manualChunks: {
          leaflet: ["leaflet"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "favicon.svg", "robots.txt"],
      manifest: {
        id: "/",
        name: "GeoChase - 場所当て×追跡ゲーム",
        short_name: "GeoChase",
        description: "ストリート画像で場所を当てる位置推理ゲーム。移動し続ける逃走者を追跡する逃走モード付き。",
        lang: "ja",
        dir: "ltr",
        theme_color: "#070C0B",
        background_color: "#070C0B",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone", "browser"],
        orientation: "any",
        scope: "/",
        start_url: "/",
        categories: ["games", "education", "travel"],
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // maskableが無いとAndroidでアイコンが白い四角に切り抜かれる
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "逃走モードで始める", short_name: "逃走", url: "/?mode=chase" },
          { name: "通常モードで始める", short_name: "通常", url: "/?mode=classic" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
        // mapillary-jsは約1MBある。初回訪問でいきなり落とすと重いので、
        // プリキャッシュから外して「実際に画像を見るとき」に取得＋キャッシュする
        globIgnores: ["**/mapillary*.js"],
        // SPAなので、未知のパスはindex.htmlに戻す
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // mapillary-jsのチャンクは大きいので上限を引き上げる
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // プリキャッシュから外したmapillary-jsチャンクを、初回取得時にキャッシュする
            urlPattern: /\/assets\/mapillary.*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "mapillary-lib",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 地図・写真タイル（地理院タイル）。
            // OSM公式タイルは利用ポリシー上アプリ配布に使えないため、
            // MapView.tsx ごと地理院タイルへ移行した。ここも合わせて差し替える。
            // 「一度見た範囲を再訪時に使い回す」だけの通常キャッシュで、
            // 先読み・一括ダウンロードはしていない。
            urlPattern: /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gsi-tiles",
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // VITE_WORLD_* で世界タイル（ArcGIS等）を設定したとき用。
            // 未設定ならこのパターンは一度も一致しないので害はない。
            urlPattern: /^https:\/\/.*\.arcgis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "world-tiles",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Mapillaryの画像は署名付きで期限があるため、短めのStaleWhileRevalidate
            urlPattern: /^https:\/\/.*\.mapillary\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mapillary",
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // 開発中もPWAの挙動を確認したいときは true にする
        enabled: false,
      },
    }),
  ],
});