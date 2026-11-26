# ytdlp-api-worker

`GET /api/v1/stream/{videoid}` を提供する Cloudflare Worker。

## デプロイ手順
1. `npm install`
2. `npx wrangler login`
3. (任意) yt-dlpバックエンドを使う場合
   - `backend/` を VPS / Render / Fly.io などにデプロイ
     - `pip install -r requirements.txt`
     - `TOKEN=任意の文字列 gunicorn -b 0.0.0.0:8080 server:app`
   - `wrangler.toml` の `[vars]` に `YTDLP_BACKEND` を設定
   - `npx wrangler secret put YTDLP_BACKEND_TOKEN` (上の TOKEN と同じ値)
4. (任意) `npx wrangler secret put API_KEY` でAPIキー必須にする
5. `npx wrangler deploy`

## 使い方
```
curl https://ytdlp-api.<your-subdomain>.workers.dev/api/v1/stream/dQw4w9WgXcQ
curl -H "x-api-key: ..." ".../api/v1/stream/<id>?provider=ytdlp"
".../api/v1/stream/<id>?redirect=1"   # 最良の映像+音声URLへ302
```

## ローカル確認
`npx wrangler dev` → http://localhost:8787/api/v1/stream/{videoid}
