# Carryover — Next.js standalone build (breezy-bets/clientfirst two-stage pattern).
# NEXT_PUBLIC_* vars are inlined at BUILD time from .env (copied with the source),
# so the image is built on the box it runs on. Server-only secrets (POSTGRES_*)
# are also read at runtime via the compose env_file.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3004 HOSTNAME=0.0.0.0
# Run as the image's unprivileged `node` user, not root. The app only ever writes
# under /app (Next's own cache) and /tmp, so it needs nothing more — and if a
# request ever does get code running in this process, it should not be running
# as root in the container. /app stays owned by `node` because Next writes its
# image and revalidation caches there at runtime.
RUN chown node:node /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Migrations (and later, library seeds) must exist at runtime for the
# instrumentation-hook migration runner (instrumentation.ts -> lib/db/migrate.ts).
COPY --from=build --chown=node:node /app/db ./db
USER node
EXPOSE 3004
CMD ["node", "server.js"]
