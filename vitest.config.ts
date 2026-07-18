// Vitest needs the "@/" alias tsconfig gives Next (until step 3, every "@/"
// import reached by tests was type-only and got erased before resolution —
// value imports made the gap real).

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
