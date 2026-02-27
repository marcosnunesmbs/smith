# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install --legacy-peer-deps

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/

# Build TypeScript
RUN npm run build

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:20-slim

# System dependencies for DevKit tools (git, shell, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    git \
    curl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production deps only
COPY package*.json ./
RUN npm install --legacy-peer-deps --omit=dev

# Copy compiled output + bin from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

# Create Smith home directory for config, logs, PID, browser cache
RUN mkdir -p /root/.smith/logs /root/.smith/cache

# Default port for Smith WebSocket server
EXPOSE 7900

# Environment variables (can be overridden at runtime)
ENV SMITH_HOME=/root/.smith
ENV NODE_ENV=production

# Use dumb-init for proper signal forwarding (graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]

# Remove stale PID file from previous container run, then start
CMD ["sh", "-c", "rm -f /root/.smith/smith.pid && node bin/smith.js start"]

# Health check — Smith is alive if its PID file exists and process is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -f /root/.smith/smith.pid && kill -0 $(cat /root/.smith/smith.pid) || exit 1
