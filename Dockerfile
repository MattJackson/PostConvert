# Sharp-maintained runtime with libvips prebuilt (better HEIF success rate)
FROM ghcr.io/lovell/sharp-node:20

RUN apt-get update && apt-get install -y \
  ffmpeg \
  poppler-utils \
  imagemagick \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm i

COPY server.js ./
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
