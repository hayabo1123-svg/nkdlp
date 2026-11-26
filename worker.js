/**
 * Cloudflare Worker: /api/v1/stream/{videoid}
 *
 * プロバイダを順番に試して、最初に成功した結果を返します。
 *   1. ytdlp     : 別サーバーで動かしている yt-dlp (server.py) を呼ぶ
 *   2. innertube : Worker から YouTube 内部API(Innertube)を直接呼ぶ
 *   3. custom    : 任意の外部エンドポイント (CUSTOM_PROVIDER_URL) を呼ぶ ※Freemake等を使う場合の差し込み口
 *
 * 環境変数 (wrangler.toml / ダッシュボードで設定)
 *   YTDLP_BACKEND       例: https://ytdlp.example.com  (server.py のURL)
 *   YTDLP_BACKEND_TOKEN yt-dlpバックエンド用トークン (任意)
 *   CUSTOM_PROVIDER_URL 例: https://example.com/extract?id={id}  ({id} が動画IDに置換される)
 *   API_KEY             設定するとこのAPIに x-api-key ヘッダーが必須になる (任意)
 *
 * クエリ:
 *   ?provider=ytdlp|innertube|custom  使うプロバイダを固定
 *   ?redirect=1                       最良の映像+音声一体フォーマットへ302リダイレクト
 *   ?nocache=1                        キャッシュを無視
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CACHE_TTL = 300; // 秒 (ストリームURLは期限付きなので短め)

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/stream\/([^/]+)\/?$/);
    if (!match) return json({ error: "not_found", usage: "/api/v1/stream/{videoid}" }, 404);

    if (env.API_KEY && request.headers.get("x-api-key") !== env.API_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    const id = match[1];
    if (!VIDEO_ID_RE.test(id)) return json({ error: "invalid_video_id" }, 400);

    const forced = url.searchParams.get("provider");
    const wantRedirect = url.searchParams.get("redirect") === "1";
    const noCache = url.searchParams.get("nocache") === "1";

    // キャッシュ
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.local/stream/${id}/${forced || "auto"}`);
    let data = null;
    if (!noCache) {
      const hit = await cache.match(cacheKey);
      if (hit) data = await hit.json();
    }

    if (!data) {
      const providers = buildProviders(env, forced);
      if (providers.length === 0) return json({ error: "no_provider_available" }, 400);

      const errors = [];
      for (const p of providers) {
        try {
          data = await p.fn(id);
          if (data && data.formats && data.formats.length) {
            data.provider = p.name;
            break;
          }
          errors.push({ provider: p.name, error: "no_formats" });
          data = null;
        } catch (e) {
          errors.push({ provider: p.name, error: String(e && e.message ? e.message : e) });
          data = null;
        }
      }
      if (!data) return json({ error: "extract_failed", details: errors }, 502);

      data.best = pickBest(data.formats);
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL}` },
          })
        )
      );
    }

    if (wantRedirect) {
      const target = (data.best && (data.best.muxed || data.best.video)) || null;
      if (!target) return json({ error: "no_playable_format" }, 404);
      return withCors(Response.redirect(target.url, 302));
    }

    return json(data, 200);
  },
};

/* ---------------- Providers ---------------- */

function buildProviders(env, forced) {
  const all = [];
  if (env.YTDLP_BACKEND) all.push({ name: "ytdlp", fn: (id) => viaYtdlp(env, id) });
  all.push({ name: "innertube", fn: (id) => viaInnertube(id) });
  if (env.CUSTOM_PROVIDER_URL) all.push({ name: "custom", fn: (id) => viaCustom(env, id) });
  return forced ? all.filter((p) => p.name === forced) : all;
}

// 1) yt-dlp バックエンド (server.py)
async function viaYtdlp(env, id) {
  const headers = {};
  if (env.YTDLP_BACKEND_TOKEN) headers["authorization"] = `Bearer ${env.YTDLP_BACKEND_TOKEN}`;
  const res = await fetch(`${env.YTDLP_BACKEND.replace(/\/$/, "")}/extract?id=${id}`, { headers });
  if (!res.ok) throw new Error(`ytdlp backend HTTP ${res.status}`);
  const info = await res.json(); // yt-dlp -J 相当
  const formats = (info.formats || [])
    .filter((f) => f.url && f.protocol !== "mhtml" && !String(f.format_id).startsWith("sb"))
    .map((f) => ({
      id: String(f.format_id),
      url: f.url,
      ext: f.ext || null,
      mime: null,
      quality: f.format_note || (f.height ? `${f.height}p` : null),
      width: f.width || null,
      height: f.height || null,
      fps: f.fps || null,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : null,
      hasVideo: !!f.vcodec && f.vcodec !== "none",
      hasAudio: !!f.acodec && f.acodec !== "none",
      contentLength: f.filesize || f.filesize_approx || null,
      protocol: f.protocol || null,
    }));
  return {
    id,
    title: info.title || null,
    author: info.uploader || info.channel || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    formats,
  };
}

// 2) Innertube 直叩き (ANDROID クライアント)
async function viaInnertube(id) {
  const body = {
    videoId: id,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        osName: "Android",
        osVersion: "11",
        hl: "ja",
        gl: "JP",
      },
    },
  };
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
      "x-youtube-client-name": "3",
      "x-youtube-client-version": "20.10.38",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`innertube HTTP ${res.status}`);
  const j = await res.json();
  const status = j.playabilityStatus && j.playabilityStatus.status;
  if (status !== "OK") {
    throw new Error(`playability: ${status} ${(j.playabilityStatus && j.playabilityStatus.reason) || ""}`.trim());
  }
  const sd = j.streamingData || {};
  const raw = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].filter((f) => f.url); // 署名暗号(cipher)付きは除外
  const formats = raw.map((f) => {
    const mime = f.mimeType || "";
    return {
      id: String(f.itag),
      url: f.url,
      ext: mime.includes("webm") ? "webm" : mime.includes("mp4") ? (mime.startsWith("audio") ? "m4a" : "mp4") : null,
      mime,
      quality: f.qualityLabel || f.audioQuality || null,
      width: f.width || null,
      height: f.height || null,
      fps: f.fps || null,
      bitrate: f.bitrate || null,
      hasVideo: mime.startsWith("video/"),
      hasAudio: mime.startsWith("audio/") || !!f.audioQuality,
      contentLength: f.contentLength ? Number(f.contentLength) : null,
      protocol: "https",
    };
  });
  const vd = j.videoDetails || {};
  return {
    id,
    title: vd.title || null,
    author: vd.author || null,
    duration: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
    thumbnail: vd.thumbnail && vd.thumbnail.thumbnails ? vd.thumbnail.thumbnails.slice(-1)[0].url : null,
    formats,
  };
}

// 3) 任意の外部プロバイダ
//    CUSTOM_PROVIDER_URL が次の形のJSONを返す前提:
//    { title, author, duration, thumbnail, formats:[{id,url,ext,height,hasVideo,hasAudio,...}] }
async function viaCustom(env, id) {
  const res = await fetch(env.CUSTOM_PROVIDER_URL.replace("{id}", id));
  if (!res.ok) throw new Error(`custom provider HTTP ${res.status}`);
  const j = await res.json();
  return { id, ...j };
}

/* ---------------- Helpers ---------------- */

function pickBest(formats) {
  const byHeightDesc = (a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0);
  const muxed = formats.filter((f) => f.hasVideo && f.hasAudio).sort(byHeightDesc)[0] || null;
  const video = formats.filter((f) => f.hasVideo && !f.hasAudio).sort(byHeightDesc)[0] || null;
  const audio = formats.filter((f) => !f.hasVideo && f.hasAudio).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;
  return { muxed, video, audio };
}

function json(obj, status = 200) {
  return withCors(
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  );
}

function withCors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type, x-api-key");
  h.set("access-control-allow-methods", "GET, OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}
