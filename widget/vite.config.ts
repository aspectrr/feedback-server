import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [solid(), dts({ tsconfigPath: "./tsconfig.json" })],
  build: {
    lib: {
      entry: "./src/index.ts",
      formats: ["es"],
      fileName: "feedback-widget",
    },
    rollupOptions: {
      external: ["solid-js", "solid-js/web", "@kobalte/core", "modern-screenshot"],
    },
  },
});
