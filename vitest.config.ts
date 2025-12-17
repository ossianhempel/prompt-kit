import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "**/.pnpm-store/**",
      "apps/desktop/src-tauri/**",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/target/**",
        "**/.pnpm-store/**",
        "apps/desktop/src-tauri/**",
        "**/*.d.ts",
        "**/*.test.ts",
      ],
    },
  },
});
