# syntax=docker/dockerfile:1

# ---- Build stage: install all deps, build client and server -----------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so dependency installation is cached between builds.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

# ---- Runtime stage: production deps + build output only ----------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# The lockfile describes every workspace, so all manifests must be present.
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev --ignore-scripts --workspace @meet-strangers/server \
    && npm cache clean --force

COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist
ENV CLIENT_DIST_DIR=/app/packages/client/dist

# Never run as root.
USER node
EXPOSE 8080
# Shell form so ${PORT} is expanded at runtime: the port is configurable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# Run node directly (not via npm) so SIGTERM reaches the process for graceful shutdown.
CMD ["node", "packages/server/dist/index.js"]
