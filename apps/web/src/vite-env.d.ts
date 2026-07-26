/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  // Mapillaryの「クライアントトークン」はブラウザに公開しても問題ない設計のトークンです
  // (Mapillary公式ドキュメント: クライアントサイドでの利用を前提としたトークン)
  readonly VITE_MAPILLARY_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
