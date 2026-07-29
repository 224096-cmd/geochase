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
        // mapillary-js / maplibre-gl / leaflet は重いので初期表示のJSから切り離す
        manualChunks: {
          leaflet: ["leaflet"],
          react: ["react", "react-dom"],
        },
      },
    },
    // maplibre-gl と mapillary-js はどちらも大きい。警告のしきい値を上げておく
    chunkSizeWarningLimit: 1600,
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
        // mapillary-js は約1MB、maplibre-gl も大きい。初回訪問でいきなり落とすと重いので、
        // プリキャッシュから外して「実際に使うとき」に取得＋キャッシュする
        globIgnores: ["**/mapillary*.js", "**/maplibre*.js"],
        // SPAなので、未知のパスはindex.htmlに戻す
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // プリキャッシュから外した大きいチャンクを、初回取得時にキャッシュする
            urlPattern: /\/assets\/(mapillary|maplibre).*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "big-libs",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenFreeMap のベクタータイル・フォント・スプライト
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "openfreemap",
              expiration: { maxEntries: 1200, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 地理院タイル（航空写真・淡色地図）
            urlPattern: /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gsi-tiles",
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // VITE_WORLD_PHOTO_URL に ArcGIS 等を設定したとき用。未設定なら一致しない
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