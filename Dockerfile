FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prefer deterministic installs. This will fail if package-lock.json is missing.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
ENV PORT=8080
EXPOSE 8080

# Run as non-root (node user exists in official node images)
USER node

CMD ["node", "server.js"]
