# syntax=docker/dockerfile:1
#
# UNVERIFIED: written without Docker on the development machine, following
# Sonda's. Build it once on the homelab before trusting it.

# --------------------------------------------------------------------- build
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies in their own layer: touching source does not invalidate npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-migrations.mjs ./scripts/

RUN npm run build && npm prune --omit=dev


# ------------------------------------------------------------- runtime image
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOOKTOPUS_DATA_DIR=/data \
    HOOKTOPUS_PORT=8080

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# GET /api/health reads the version from here; it is the single source.
COPY package.json ./
# Plain files, no build: src/app.ts serves them from ../public.
COPY public ./public

# uid 1000 ('node') owns the mount point. A named volume inherits this owner;
# a bind mount needs the host directory writable by uid 1000.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME /data

# Shell form, so ${HOOKTOPUS_PORT} expands at run time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HOOKTOPUS_PORT:-8080}/api/health" || exit 1

# Exec form: node is PID 1 and gets docker stop's SIGTERM, which src/index.ts handles.
CMD ["node", "dist/index.js"]
