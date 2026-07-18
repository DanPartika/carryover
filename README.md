# Carryover

Your PT's plan, always with you — the loop between physical-therapy visits.
App #4 on the [Lithe](../../README.md) platform. Product doc: [PRD.md](PRD.md).

## Dev quick start (standalone, no Lithe)

```bash
cp .env.example .env
# then in .env set:
#   CARRYOVER_DB_HOST=localhost
#   CARRYOVER_DB_PORT=5434
#   CARRYOVER_ALLOW_DEV_USER=1
#   NEXT_PUBLIC_LITHE_ISSUER=        (empty = auth off)
#   NEXT_PUBLIC_LITHE_CLIENT_ID=     (empty)
#   NEXT_PUBLIC_BASE_PATH=           (empty = serve at /)

docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d carryover-db
npm install
npm run dev        # http://localhost:3004 — migrations apply at boot
```

## On the platform

`scripts/lithe.sh` auto-discovers `docker-compose.yml`; register the app in
Studio to mint the OIDC client id, then set `NEXT_PUBLIC_LITHE_*` and
`NEXT_PUBLIC_BASE_PATH=/apps/carryover` in `.env` and rebuild. All AI calls go
through the platform `/v1/ai` gateway — no direct-Anthropic path exists.

## Layout

- `db/migrations/` — applied at boot by `instrumentation.ts` → `lib/db/migrate.ts`
- `lib/auth/` — the breezy-bets/clientfirst auth seam (standalone by default,
  "Login with Lithe" when configured)
- `app/api/bootstrap/` — front door: verifies JWT, upserts the user, returns
  profile + clinic memberships
