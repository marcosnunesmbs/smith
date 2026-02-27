# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/

RUN npm run build

# ─── Developer workspace stage ───────────────────────────────────────────────
FROM node:20-bookworm-slim

# ── uv + uvx from official image (no curl pipe needed) ───────────────────────
COPY --from=ghcr.io/astral-sh/uv:0.7 /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.7 /uvx /usr/local/bin/uvx

# ── System + developer tools ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # ── Process & system ──────────────────────────────────────────────────────
    dumb-init \
    procps \
    htop \
    lsof \
    # ── VCS ───────────────────────────────────────────────────────────────────
    git \
    git-lfs \
    openssh-client \
    gnupg \
    # ── Networking ────────────────────────────────────────────────────────────
    curl \
    wget \
    ca-certificates \
    netcat-openbsd \
    dnsutils \
    iputils-ping \
    nmap \
    # ── Python ────────────────────────────────────────────────────────────────
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # ── Build tools (native extensions, C/C++) ────────────────────────────────
    build-essential \
    make \
    cmake \
    pkg-config \
    # ── Database clients ──────────────────────────────────────────────────────
    sqlite3 \
    postgresql-client \
    default-mysql-client \
    redis-tools \
    # ── JSON / YAML / search ──────────────────────────────────────────────────
    jq \
    ripgrep \
    fd-find \
    # ── File utilities ────────────────────────────────────────────────────────
    zip \
    unzip \
    tar \
    gzip \
    bzip2 \
    xz-utils \
    rsync \
    # ── Text editors ──────────────────────────────────────────────────────────
    vim \
    nano \
    # ── Display / navigation ──────────────────────────────────────────────────
    tree \
    less \
    bat \
    && rm -rf /var/lib/apt/lists/*

# ── Convenience symlinks ──────────────────────────────────────────────────────
# python → python3
RUN ln -sf /usr/bin/python3 /usr/local/bin/python
# fdfind → fd  (Debian renames the binary to avoid conflict with util-linux)
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd
# batcat → bat  (same reason)
RUN ln -sf /usr/bin/batcat /usr/local/bin/bat

# ── Node.js global package managers ──────────────────────────────────────────
RUN corepack enable yarn && npm install -g pnpm

# ── pipx for isolated Python CLI tools ───────────────────────────────────────
RUN pip3 install --break-system-packages pipx

# ── PATH: uv/uvx user installs + pipx bins ───────────────────────────────────
ENV PATH="/root/.local/bin:$PATH"
ENV UV_SYSTEM_PYTHON=1

# ── Smith app ─────────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

RUN mkdir -p /root/.smith/logs /root/.smith/cache

EXPOSE 7900

ENV SMITH_HOME=/root/.smith
ENV NODE_ENV=production

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "rm -f /root/.smith/smith.pid && node bin/smith.js start"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -f /root/.smith/smith.pid && kill -0 $(cat /root/.smith/smith.pid) || exit 1
