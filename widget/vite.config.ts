import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import dts from "vite-plugin-dts";

// Two-pass lib build:
//   client pass -> dist/feedback-widget.js       (DOM runtime — browsers)
//   ssr pass    -> dist/feedback-widget.server.js (solid SSR runtime — server rendering)
// package.json exports route "node" to the server build so SSR never executes
// the client build's DOM-runtime template() calls (they throw on the server).
export default defineConfig(({ mode }) => {
	const ssr = mode === "server";
	return {
		plugins: [solid({ ssr }), ...(ssr ? [] : [dts({ tsconfigPath: "./tsconfig.json" })])],
		build: {
			// ssr pass: build.ssr makes vite-plugin-solid compile with generate:"ssr"
			...(ssr ? { ssr: "./src/index.ts" as const } : {}),
			...(ssr
				? {
						rollupOptions: {
							output: { format: "es" as const, entryFileNames: "feedback-widget.server.js" },
						},
					}
				: {
						lib: {
							entry: "./src/index.ts",
							formats: ["es" as const],
							fileName: "feedback-widget",
						},
					}),
			outDir: ssr ? "dist/server" : "dist",
			emptyOutDir: !ssr,
			rollupOptions: {
				external: ["solid-js", "solid-js/web", "@kobalte/core", "modern-screenshot"],
			},
		},
	};
});
