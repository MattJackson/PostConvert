FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
  libheif1 libheif-dev \
  libvips libvips-dev \
  \
  # HEIC/HEIF decode support (common iPhone HEVC variants)
  libde265-0 \
  libheif-plugin-libde265 \
  \
  # Additional decoder plugin (if available in repo; improves compatibility)
  libheif-plugin-ffmpegdec \
  \
  # PDF rendering
  poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm i

COPY server.js ./
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
