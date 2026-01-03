FROM node:20-bookworm-slim

# Enable bookworm-backports so we can install libheif plugins
RUN echo "deb http://deb.debian.org/debian bookworm-backports main" > /etc/apt/sources.list.d/bookworm-backports.list

RUN apt-get update && apt-get install -y \
  libvips libvips-dev \
  poppler-utils \
  && apt-get install -y -t bookworm-backports \
  libheif1 libheif-dev libheif-plugins-all \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm i

COPY server.js ./
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
