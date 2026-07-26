# GeoChase

GeoGuessr形式の位置推理ゲーム + 「AI逃走モード」（道路沿いを移動するAIをリアルタイムで追跡して当てる）を実装したPWA。

**完全無料枠で動作する構成:**
- フロントエンド: Cloudflare Pages（無料・無制限デプロイ）
- API/ゲームロジック: Cloudflare Workers（無料枠 10万リクエスト/日）
- リアルタイム通信: Durable Objects（無料枠 SQLiteバックエンド、2025年4月よりFreeプランで利用可能）
- データベース: Cloudflare D1（無料枠 5GB）
- 画像: Mapillary API（無料、要アカウント登録のみ）
- ルーティング: OSRM公開デモサーバー（無料、商用不可・個人利用OK）

有料が発生するとしたら「Workers Paid ($5/月)」への切り替えが必要なほど利用が伸びた場合のみです。個人開発・少人数プレイなら無料枠内に収まります。

## ディレクトリ構成

```
geochase/
├── apps/
│   ├── web/     # PWAフロントエンド (Vite + React + Leaflet)
│   └── api/     # Cloudflare Workers + Durable Object
├── .github/workflows/deploy.yml
└── README.md    # このファイル
```

---

## 0. 事前準備（アカウント登録・すべて無料）

| サービス | 用途 | URL |
|---|---|---|
| GitHub | コード管理・CI/CD | https://github.com/signup |
| Cloudflare | Workers / Pages / D1 / Durable Objects | https://dash.cloudflare.com/sign-up |
| Mapillary | ストリートレベル画像API | https://www.mapillary.com/dashboard/developers |
| Node.js 20+ | ローカル開発環境 | https://nodejs.org |

### Mapillaryのクライアントトークン取得手順
1. https://www.mapillary.com にサインアップ（無料）
2. https://www.mapillary.com/dashboard/developers を開く
3. 「Register application」→ アプリ名を入力（例: geochase）
4. 発行された **Client Token**（`MLY|xxxxx`形式）を控えておく

---

## 1. GitHubリポジトリ作成

```bash
gh repo create geochase --public --clone
cd geochase
# このzipの中身を展開してコミット
git add .
git commit -m "init: geochase scaffold"
git push
```

`gh`コマンドが無ければ https://github.com/new でリポジトリを作成し、`git remote add origin ...` で紐付けてください。

---

## 2. Cloudflareへログイン・APIトークン準備

```bash
npm install -g wrangler
wrangler login   # ブラウザが開くので認可する
```

GitHub Actionsから自動デプロイするために、Cloudflareダッシュボードで **APIトークン** を発行します。
1. https://dash.cloudflare.com/profile/api-tokens → 「トークンを作成」
2. テンプレート「Edit Cloudflare Workers」を選択して作成
3. 発行されたトークンをコピー
4. GitHubリポジトリ → Settings → Secrets and variables → Actions → 「New repository secret」
   - 名前: `CLOUDFLARE_API_TOKEN`
   - 値: 上記トークン

---

## 3. バックエンド (apps/api) セットアップ

```bash
cd apps/api
npm install
```

### D1データベース作成
```bash
wrangler d1 create geochase-db
```
出力される `database_id` を `wrangler.toml` の `[[d1_databases]]` セクションに貼り付けてください。

```bash
wrangler d1 execute geochase-db --remote --file=./schema.sql
```

### KVネームスペース作成
```bash
wrangler kv namespace create SESSIONS
```
出力される `id` を `wrangler.toml` の `[[kv_namespaces]]` セクションに貼り付けてください。

### シークレット登録（Mapillaryトークン）
```bash
wrangler secret put MAPILLARY_TOKEN
# プロンプトが出たら控えておいたMLY|xxxxxを貼り付けてEnter
```

### ローカル動作確認
```bash
wrangler dev
```
`http://localhost:8787` でAPIが立ち上がります。

### 本番デプロイ（初回は手動でOK。以降はGitHub Actionsが自動実行）
```bash
wrangler deploy
```
デプロイ完了後に表示されるURL（例: `https://geochase-api.<あなたのサブドメイン>.workers.dev`）を控えておいてください。

---

## 4. フロントエンド (apps/web) セットアップ

```bash
cd ../web
npm install
```

`.env` ファイルを作成し、APIのURLを設定:
```bash
echo "VITE_API_URL=https://geochase-api.<あなたのサブドメイン>.workers.dev" > .env
```

### ローカル動作確認
```bash
npm run dev
```
`http://localhost:5173` で確認できます。

### アイコン画像を用意
`apps/web/public/icon-192.png` と `icon-512.png` を差し替えてください（PWAインストール時に使用されます。ひとまずダミーでもOK）。

---

## 5. Cloudflare Pagesへの接続（フロントエンドの自動デプロイ）

1. Cloudflareダッシュボード → 「Workers & Pages」→「Pages」→「Gitに接続」
2. GitHubを認可し、`geochase` リポジトリを選択
3. ビルド設定:
   - フレームワークプリセット: Vite
   - ルートディレクトリ: `apps/web`
   - ビルドコマンド: `npm run build`
   - ビルド出力ディレクトリ: `dist`
4. 環境変数に `VITE_API_URL` を追加（上記で控えたWorkers URL）
5. 「保存してデプロイ」

これで `main` ブランチへのpushのたびに自動でPagesがデプロイされます。

---

## 6. GitHub ActionsでAPI側も自動デプロイ

`.github/workflows/deploy.yml` がすでに含まれています。`CLOUDFLARE_API_TOKEN` をSecretsに登録済みであれば、`apps/api/` 配下への変更をpushすると自動で `wrangler deploy` が走ります。

---

## 7. 動作確認チェックリスト

- [ ] `wrangler dev` でAPIがローカル起動する
- [ ] `npm run dev`（web）でフロントが起動し、地図が表示される
- [ ] `/api/room/start` を叩くとAI逃走モードが開始し、WebSocketで位置更新が届く
- [ ] Cloudflare Pagesの本番URLにスマホでアクセスし、「ホーム画面に追加」でPWAとしてインストールできる

---

## 詳しい実装解説

- `apps/api/src/GameRoom.ts` — Durable Object本体。AI逃走モードのゲームロジック
- `apps/api/src/mapillary.ts` — Mapillary画像取得・道路上ランダム地点抽出
- `apps/web/src/components/MapView.tsx` — Leaflet地図（ピン設置・AI軌跡表示）
- `apps/web/src/components/StreetView.tsx` — Mapillary画像ビューア（パノラマ簡易表示）

各ファイルにコメントで補足しています。
