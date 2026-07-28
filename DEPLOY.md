# 本設デプロイ手順（24時間つなぎっぱなしにする）

`online/` は自己完結済み（`server/game.html`＋`public/tiles.png` 同梱、親フォルダ不要）で、
すでにローカル git リポジトリとして初回コミット済みです。あとは **あなたのアカウント** で
GitHub にプッシュ → ホスティングサービスに接続するだけです。

WebSocket(wss) はサービス側の HTTPS 終端で自動対応します（クライアントは自動で ws/wss を切替）。

---

## ステップ0：GitHub にプッシュ（全サービス共通）

1. GitHub で空のリポジトリを作成（例：`mahjong-online`）。READMEやgitignoreは付けない。
2. 表示された「push an existing repository」のURLを使い、このフォルダで：

```bash
cd "/Users/seki/Desktop/アプリ開発/seki/Game/麻雀/online"
git remote add origin https://github.com/<あなた>/mahjong-online.git
git push -u origin main
```

---

## 推奨：Render（無料・最速・クリックだけ）

1. https://render.com にログイン（GitHubアカウントで可）。
2. **New +** → **Blueprint** を選択。
3. さきほどの `mahjong-online` リポジトリを選ぶ。
4. `render.yaml` が自動検出される → **Apply / Deploy**。
5. 数分でビルド完了 → `https://mahjong-online-xxxx.onrender.com` が発行。
   - ヘルスチェック `/health` が緑になれば稼働中。

これで恒久URLの完成。友達にURLを渡すだけで対戦できます。

### 無料プランの注意（コールドスタート）
- 無料Webサービスは **約15分アクセスが無いとスリープ**し、次アクセス時に **約50秒** 起動待ちが出ます。
- 常時起動にするには **Starter プラン（約$7/月）** にアップグレードでも可（Renderのサービス設定から）。
- ただし本リポジトリには **無料のまま眠らせないキープアライブ機構を同梱済み**（下記）。

---

## 無料のまま眠らせない（キープアライブ設定）

### 方法A：GitHub Actions（同梱済み・追加登録なし）★推奨
リポジトリに `.github/workflows/keepalive.yml` を同梱済み。10分おきに `/health` を叩いて起こし続けます。
デプロイ後に **URLを1つ登録するだけ**：

1. GitHub のリポジトリ → **Settings** → **Secrets and variables** → **Actions** → **Variables** タブ
2. **New repository variable**
   - Name: `RENDER_URL`
   - Value: `https://<あなたのアプリ>.onrender.com`（末尾スラッシュ無し）
3. 保存 → **Actions** タブで `keep-alive` を選び **Run workflow** で即時テスト（緑になればOK）

以後は自動で10分おきにpingします。手動で止めたい時は Actions タブでワークフローを Disable。

> 注意：GitHub無料枠のスケジュールは負荷次第で数分ずれることがあります。また **リポジトリが60日間まったく更新されないとスケジュールが自動停止** します（時々コミットするか、下の方法Bを併用）。

### 方法B：cron-job.org（外部・より正確）
より時間に正確に起こしたい場合：

1. https://cron-job.org に無料登録
2. Create cronjob → URL に `https://<あなたのアプリ>.onrender.com/health`
3. 実行間隔を **Every 10 minutes** に設定 → 保存

方法AとBは併用可能（どちらか一方でも十分）。どちらも完全無料です。

---

## 代替A：Fly.io（Docker・世界エッジ・無料枠あり）

前提：`flyctl` インストール＋クレジットカード登録（無料枠内なら無課金）。

```bash
cd "/Users/seki/Desktop/アプリ開発/seki/Game/麻雀/online"
brew install flyctl        # 未導入なら
fly auth login
fly launch --now           # Dockerfile を自動検出。地域は nrt(東京) 推奨
```

- `PORT` は Fly が注入（Dockerfileは `PORT` 未指定時 8080）。
- wss は Fly の HTTPS で自動対応。`fly open` でブラウザが開く。

## 代替B：Railway（GitHub連携・簡単）

1. https://railway.app にログイン。
2. **New Project** → **Deploy from GitHub repo** → `mahjong-online`。
3. Railway が Node を自動検出（`npm install` → `node server/index.js`）。
   `Procfile`（`web: node server/index.js`）も認識されます。
4. 発行されたドメインでアクセス。

## 代替C：自前VPS / 任意のDocker環境

```bash
cd "/Users/seki/Desktop/アプリ開発/seki/Game/麻雀/online"
docker build -t mahjong-online .
docker run -d -p 8080:8080 --restart unless-stopped mahjong-online
# 前段に nginx/caddy 等で TLS を張れば wss が通ります
```

---

## デプロイ後の確認

```bash
curl https://<あなたのURL>/health      # → ok tables=0 clients=0
```

ブラウザで開く → 名前入力 → 「1人で(CPU3人)」で即対局できれば成功です。
「ルームを作る」で出る🔑合言葉を友達に伝えれば、同じ卓に後から参加できます。
