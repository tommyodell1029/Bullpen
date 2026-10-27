# cloud/Dockerfile — the station as one always-on container.
# Build context is the repository root:  docker build -f cloud/Dockerfile .
FROM node:22-bookworm-slim

# git: agent checkpoints and code work · chromium: the browser agents drive · tini: clean signal handling
# python3/make/g++: build node-pty's native module during npm ci
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git chromium fonts-liberation ca-certificates tini curl python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Claude Code — the station's "Claude Code" brain runs this CLI with whatever account it is signed in with
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Everything else the sidecar needs (see .dockerignore for what is left out)
COPY . .
RUN chmod +x cloud/start.sh

ENV NODE_ENV=production \
    DATA_DIR=/data
# Railway mounts the persistent volume here (crews, chats, sign-ins survive redeploys)
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/__gateway/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/cloud/start.sh"]
