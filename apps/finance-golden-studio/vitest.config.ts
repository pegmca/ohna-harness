import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/web/test/setup.ts"],
    include: ["src/web/**/*.test.ts", "src/web/**/*.test.tsx"]
  }
});
