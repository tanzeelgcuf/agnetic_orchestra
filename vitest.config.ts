import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@orchestra/shared": r("packages/shared/src/index.ts"),
      "@orchestra/observability": r("packages/observability/src/index.ts"),
      "@orchestra/database": r("packages/database/src/index.ts"),
      "@orchestra/event-bus": r("packages/event-bus/src/index.ts"),
      "@orchestra/workflow-engine": r("packages/workflow-engine/src/index.ts"),
      "@orchestra/agents": r("packages/agents/src/index.ts"),
      "@orchestra/integrations": r("packages/integrations/src/index.ts"),
      "@orchestra/claude-code": r("packages/claude-code/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
