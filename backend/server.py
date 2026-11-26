# yt-dlp バックエンド (Worker の YTDLP_BACKEND に指定するサーバー)
#   pip install flask yt-dlp
#   TOKEN=secret python server.py
import os
from flask import Flask, request, jsonify, abort
import yt_dlp

app = Flask(__name__)
TOKEN = os.environ.get("TOKEN")


@app.get("/extract")
def extract():
    if TOKEN and request.headers.get("authorization") != f"Bearer {TOKEN}":
        abort(401)
    vid = request.args.get("id", "")
    if len(vid) != 11:
        abort(400)
    opts = {"quiet": True, "skip_download": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
        return jsonify(ydl.sanitize_info(info))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
