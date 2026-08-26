# syntax=docker/dockerfile:1
FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The package prepare hook builds from src, which is copied in the next layer.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts cordis.patch.yml README.md LICENSE ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    DSH_CODEX_TEAM_BROKER_HOST=0.0.0.0 \
    DSH_CODEX_TEAM_BROKER_PORT=8788
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
# The source build keeps peer packages used by the DSH/Codex OAuth adapter.
# A published-image pipeline can replace this with a locked production install.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/lib ./lib
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_CODEX_TEAM_BROKER_PORT||'8788')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "lib/team-broker-bin.js"]
