import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The real-module tier compiles the 12.6 MB module per file, which can
    // take longer than the 5 s default on a busy machine.
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/js/**/*.ts"],
    },
  },
});
