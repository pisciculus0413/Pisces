import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pisces/protocol": source("./packages/protocol/src/index.ts"),
      "@pisces/core": source("./packages/core/src/index.ts"),
      "@pisces/daemon": source("./packages/daemon/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
  },
});
