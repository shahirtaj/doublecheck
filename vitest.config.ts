import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror tsconfig's `@/*` path alias (project root). Vitest doesn't read
// tsconfig paths, and the API route modules under test import "@/lib/...".
//
// The default test environment stays node (algorithm + route-logic tests).
// Component tests opt into jsdom per file with a `// @vitest-environment
// jsdom` docblock so the two kinds mix in one run.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.dirname(fileURLToPath(import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The suite's heavy seeded sweeps (60+ buildSchedule calls per test)
    // run ~2s unloaded but have tripped the 5s default twice under
    // parallel machine load - wall-clock flakes, not determinism breaks
    // (outcomes are seeded). The headroom keeps the no-flakiness
    // guarantee about results; a genuine hang still fails, just slower.
    testTimeout: 20_000,
  },
});
