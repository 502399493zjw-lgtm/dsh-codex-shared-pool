# syntax=docker/dockerfile:1
FROM node:24-alpine

ENV NODE_ENV=production \
    DSH_CODEX_TEAM_EDGE_HOST=0.0.0.0 \
    DSH_CODEX_TEAM_EDGE_PORT=3080
WORKDIR /app
COPY --chown=node:node deploy/edge/server.mjs ./server.mjs
USER node
EXPOSE 3080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:3080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "server.mjs"]
