FROM node:20-bookworm-slim

# Force sharp to ignore any globally-installed libvips (use bundled binaries)
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1

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
