FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
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

# yt-dlp's bundled JS-challenge solver (for YouTube's bot-detection) needs a
# JS runtime to execute the challenge script -- Deno is the one clipper-service
# (a sibling project on this same host) already validated works, avoiding any
# manual cookies.txt export.
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- --no-modify-path

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
