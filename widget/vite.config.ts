import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import dts from "vite-plugin-dts";

// Two-pass lib build:
//   client pass -> dist/feedback-widget.js  (DOM runtime — non-Solid bundlers)
//   ssr pass    -> dist/server/index.js     (solid SSR runtime — plain-node SSR)
// package.json exports route "node" to the server build. Solid hosts use
// neither: the "solid" condition points at src/index.ts, so the host's
// vite-plugin-solid compiles SSR + client from the same source — no
// prebuilt client/server pair to drift apart.
export default defineConfig(({ mode }) => {
	const ssr = mode === "server";
	return {
		plugins: [solid({ ssr }), ...(ssr ? [] : [dts({ tsconfigPath: "./tsconfig.json" })])],
		build: {
			// ssr pass: build.ssr makes vite-plugin-solid compile with generate:"ssr"
			...(ssr ? { ssr: "./src/index.ts" as const } : {}),
			outDir: ssr ? "dist/server" : "dist",
			emptyOutDir: !ssr,
			...(ssr
				? {}
				: {
						lib: {
							entry: "./src/index.ts",
							formats: ["es" as const],
							fileName: "feedback-widget",
						},
					}),
			rollupOptions: {
				// Regexes, not exact strings: source imports subpaths like
				// @kobalte/core/dialog, which exact-match externals miss — the
				// dependency then gets bundled into dist.
				external: [/^solid-js($|\/)/, /^@kobalte\/core($|\/)/, "modern-screenshot"],
			},
		},
	};
});
