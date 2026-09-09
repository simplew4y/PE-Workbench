# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS builder

ENV HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1

RUN sed -i \
        -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
        -e 's|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        make \
        g++ \
        python3 \
        python3-venv \
        pkg-config \
        libcairo2-dev \
        libpango1.0-dev \
        libjpeg-dev \
        libgif-dev \
        librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000

WORKDIR /workspace

COPY PE-Workbench-pi ./PE-Workbench-pi
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefix ./PE-Workbench-pi \
    && npm run build:offline --prefix ./PE-Workbench-pi

COPY PE-Workbench-pi-web/package.json PE-Workbench-pi-web/package-lock.json ./PE-Workbench-pi-web/
COPY PE-Workbench-pi-web/services/pe-ingest/requirements.txt ./PE-Workbench-pi-web/services/pe-ingest/requirements.txt
RUN --mount=type=cache,target=/root/.npm \
    python3 -m venv ./PE-Workbench-pi-web/services/pe-ingest/.venv \
    && PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
        ./PE-Workbench-pi-web/services/pe-ingest/.venv/bin/pip install --no-cache-dir -r ./PE-Workbench-pi-web/services/pe-ingest/requirements.txt \
    && npm ci --prefix ./PE-Workbench-pi-web --registry=https://registry.npmmirror.com --no-audit --no-fund

COPY PE-Workbench-pi-web ./PE-Workbench-pi-web
RUN npm run build --prefix ./PE-Workbench-pi-web

FROM node:${NODE_VERSION}-bookworm-slim AS worker

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/pi \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PE_MULTI_USER_MODE=1 \
    PE_RUNTIME_ROLE=worker \
    PE_USER_ROOT=/home/pi

RUN sed -i \
        -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
        -e 's|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/pi/.pi/agent \
    && chown -R node:node /home/pi

WORKDIR /workspace/PE-Workbench-pi-web

COPY --from=builder --chown=node:node /workspace/PE-Workbench-pi /workspace/PE-Workbench-pi
COPY --from=builder --chown=node:node /workspace/PE-Workbench-pi-web /workspace/PE-Workbench-pi-web

USER node

EXPOSE 30141

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:30141/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["sh", "-c", "test ${#PE_WORKER_CAPABILITY} -ge 32 || { echo 'PE_WORKER_CAPABILITY must contain at least 32 characters' >&2; exit 1; }; exec npm run start:lan"]
