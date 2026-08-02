import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2020",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          leaflet: ["leaflet"],
          react: ["react", "react-dom"],
        },
      },
    },
    chunkSizeWarningLimit: 1600,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
      },
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
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "逃走モードで始める", short_name: "逃走", url: "/?mode=chase" },
          { name: "通常モードで始める", short_name: "通常", url: "/?mode=classic" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
        globIgnores: ["**/mapillary*.js", "**/maplibre*.js", "ads/*.html"],
        navigateFallback: "index.html",
        // /ads/ を除外しないと、iframeの読み込みがナビゲーション扱いになり
        // index.html が返ってiframeの中にアプリ本体が入る（広告が出なくなる）
        navigateFallbackDenylist: [/^\/api\//, /^\/ads\//],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/(mapillary|maplibre).*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "big-libs",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "openfreemap",
              expiration: { maxEntries: 1200, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gsi-tiles",
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Mapillaryの画像URLは署名付きで期限がある
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
        enabled: false,
      },
    }),
  ],
});