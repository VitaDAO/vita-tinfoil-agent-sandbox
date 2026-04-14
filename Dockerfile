FROM node:22-bookworm

# System deps (matching E2B template)
RUN apt-get update && apt-get install -y curl sqlite3 && rm -rf /var/lib/apt/lists/*

# OpenClaw (strip CUDA/GPU libs — not needed in CPU-only sandbox)
RUN npm install -g openclaw@2026.3.11 \
    && rm -rf /usr/local/lib/node_modules/openclaw/node_modules/@node-llama-cpp/linux-x64-cuda* \
    && rm -rf /usr/local/lib/node_modules/openclaw/node_modules/@node-llama-cpp/linux-x64-vulkan* \
    && chmod -R 755 /usr/local/lib/node_modules/openclaw/extensions

# App code
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY openclaw.json ./
COPY run-agent.mjs ./
COPY cron-watcher.js ./
COPY server.mjs ./
COPY decrypt.mjs ./
COPY fetch-health-data.mjs ./
COPY boot.sh ./
COPY skills/ ./skills/

# OpenClaw workspace setup
RUN mkdir -p /home/user/.openclaw/workspace /home/user/.openclaw/skills \
    && cp /app/openclaw.json /home/user/.openclaw/openclaw.json \
    && cp -r /app/skills/* /home/user/.openclaw/skills/ \
    && chown -R node:node /home/user/.openclaw \
    && chown -R node:node /app \
    && chmod +x /app/boot.sh

ENV HOME=/home/user

USER node
EXPOSE 3000

CMD ["/app/boot.sh"]
