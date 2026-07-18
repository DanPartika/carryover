# Carryover — Next.js standalone build (breezy-bets/clientfirst two-stage pattern).
# NEXT_PUBLIC_* vars are inlined at BUILD time from .env (copied with the source),
# so the image is built on the box it runs on. Server-only secrets (POSTGRES_*)
# are also read at runtime via the compose env_file.
FROM node:20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3004 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Migrations (and later, library seeds) must exist at runtime for the
# instrumentation-hook migration runner (instrumentation.ts -> lib/db/migrate.ts).
COPY --from=build /app/db ./db
EXPOSE 3004
CMD ["node", "server.js"]
