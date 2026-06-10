import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror tsconfig's `@/*` path alias (project root). Vitest doesn't read
// tsconfig paths, and the API route modules under test import "@/lib/...".
export default defineConfig({
  resolve: {
    alias: {
      "@": path.dirname(fileURLToPath(import.meta.url)),
    },
  },
});
