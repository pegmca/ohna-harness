# syntax=docker/dockerfile:1.7
FROM node:22.14.0-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/channels/package.json packages/channels/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/eval/package.json packages/eval/package.json
COPY packages/identity/package.json packages/identity/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/parsing/package.json packages/parsing/package.json
COPY packages/rag/package.json packages/rag/package.json
COPY packages/report/package.json packages/report/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/trace/package.json packages/trace/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/workflow/package.json packages/workflow/package.json
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY system.css ./system.css
RUN pnpm build

FROM node:22.14.0-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/package.json /workspace/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/api ./apps/api
COPY --from=build --chown=node:node /workspace/packages ./packages
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

FROM nginxinc/nginx-unprivileged:1.27.4-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
