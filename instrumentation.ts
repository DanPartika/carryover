// Next.js instrumentation hook: register() runs once per server start (dev,
// `next start`, and the standalone server.js — it is bundled by output:'standalone')
// and is NOT run at build time. Applies db/migrations/*.sql — no Docker CMD
// gymnastics (clientfirst pattern). Library/equipment seeds join here in build
// step 1 the same way clientfirst seeds cases at boot.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Dynamic import keeps pg out of any non-node bundle.
  const { migrateAtBoot } = await import("./lib/db/migrate");
  await migrateAtBoot();
}
