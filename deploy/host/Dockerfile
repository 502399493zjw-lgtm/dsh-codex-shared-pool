# syntax=docker/dockerfile:1
FROM node:24-alpine AS plugin-build

WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts cordis.patch.yml README.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY scripts ./scripts
COPY src ./src
COPY deploy ./deploy
RUN mkdir /out && pnpm pack --pack-destination /out

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DSH_HOME=/opt/dsh-home

# Keep the stock DSH dependency graph on the registry snapshot that contains
# the verified rc.8 release, so future sibling releases cannot drift the image.
RUN corepack disable \
    && npm install --global \
        pnpm@11.7.0 \
        @deepseek-ai/dsh@0.1.0-rc.8 \
        --before=2026-08-20T00:00:00.000Z \
    && test "$(pnpm --version)" = "11.7.0" \
    && test "$(dsh --version)" = "0.1.0-rc.8" \
    && node -e "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty')" \
    && mkdir -p /etc/dsh /opt/dsh-home /opt/dsh/deploy/host /opt/dsh/plugin-package \
    && chmod 0755 /etc/dsh \
    && chown -R node:node /opt/dsh-home

COPY --from=plugin-build --chown=root:root --chmod=0444 /out/*.tgz /opt/dsh/plugin-package/dsh-codex-shared-pool.tgz
COPY --chown=root:root --chmod=0444 deploy/host/team-host.patch.yml /etc/dsh/team-host.patch.yml
COPY --chown=root:root --chmod=0444 deploy/host/bootstrap.mjs /opt/dsh/deploy/host/bootstrap.mjs
COPY --chown=root:root --chmod=0444 deploy/host/ensure-installed-team-plugin.mjs /opt/dsh/deploy/host/ensure-installed-team-plugin.mjs
COPY --chown=root:root --chmod=0444 deploy/host/wait-for-credential-broker.mjs /opt/dsh/deploy/host/wait-for-credential-broker.mjs
COPY --chown=root:root --chmod=0444 deploy/host/start-team-host.sh /opt/dsh/deploy/host/start-team-host.sh
COPY --chown=root:root --chmod=0444 deploy/host/smoke-multi-team.mjs /opt/dsh/deploy/host/smoke-multi-team.mjs
COPY --chown=root:root --chmod=0444 deploy/host/smoke-live-sharing.mjs /opt/dsh/deploy/host/smoke-live-sharing.mjs
COPY --chown=root:root --chmod=0444 deploy/host/smoke-live-team-routing.mjs /opt/dsh/deploy/host/smoke-live-team-routing.mjs

USER node
RUN node /opt/dsh/deploy/host/ensure-installed-team-plugin.mjs \
    && test -x /opt/dsh-home/profiles/web/node_modules/dsh-codex-shared-pool/lib/team-migrate-bin.js

# The Cordis loader resolves bare plugin names from the global DSH
# installation rather than from the selected profile. Keep the plugin itself
# profile-owned, and expose only its package entry at the loader's lookup path.
USER root
RUN ln -s /opt/dsh-home/profiles/web/node_modules/dsh-codex-shared-pool \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-codex-shared-pool \
    && test -f /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-codex-shared-pool/package.json
USER node

EXPOSE 3081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team/overview').then(r=>{if(r.status !== 401)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "/opt/dsh/deploy/host/start-team-host.sh"]
