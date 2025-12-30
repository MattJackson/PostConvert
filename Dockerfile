FROM node:20-bookworm-slim

# Install native deps required for HEIC → JPEG
RUN apt-get update && apt-get install -y \
  libheif1 libheif-dev \
  libvips libvips-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install node deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy app code
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
