FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    fontconfig \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

RUN mkdir -p /app/voices && python3 -c "\
import urllib.request; \
base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx'; \
urllib.request.urlretrieve(base, '/app/voices/id_ID-news_tts-medium.onnx'); \
urllib.request.urlretrieve(base + '.json', '/app/voices/id_ID-news_tts-medium.onnx.json')"

# Anton and Montserrat Bold (both Google Fonts, OFL-licensed, freely
# redistributable) -- bundled as title/caption font presets. Registered both
# as plain files under /app/fonts (Pillow loads a font by direct file path)
# and via fontconfig (libass, used by ffmpeg's `subtitles` filter for
# captions, resolves fonts by family name, not by path). Montserrat ships
# from Google as a variable font with no separate "Montserrat Bold" file in
# the repo, so the specific static Bold instance is pulled via the CSS2 API
# (which always points at the current fonts.gstatic.com URL for that weight)
# rather than hardcoding a gstatic hash that can rotate -- this exact
# approach is already proven working in the sibling clipper-service project.
RUN mkdir -p /app/fonts /usr/share/fonts/truetype/crf \
    && curl -fsSL -o /app/fonts/Anton-Regular.ttf \
        https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf \
    && montserrat_bold_url=$(curl -fsSL -A "Mozilla/5.0" \
        "https://fonts.googleapis.com/css2?family=Montserrat:wght@700&display=swap" \
        | grep -o 'https://fonts.gstatic.com/[^)]*') \
    && curl -fsSL -o /app/fonts/Montserrat-Bold.ttf "$montserrat_bold_url" \
    && cp /app/fonts/Anton-Regular.ttf /app/fonts/Montserrat-Bold.ttf /usr/share/fonts/truetype/crf/ \
    && fc-cache -f /usr/share/fonts/truetype/crf

# yt-dlp's bundled JS-challenge solver (for YouTube's bot-detection) needs a
# JS runtime to execute the challenge script -- Deno is the one clipper-service
# (a sibling project on this same host) already validated works, avoiding any
# manual cookies.txt export.
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- --no-modify-path

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
