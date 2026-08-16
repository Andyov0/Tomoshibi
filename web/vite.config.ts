import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where the server is listening while developing. */
const server = "http://127.0.0.1:8080";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": resolve("./src"),
		},
	},
	build: {
		rollupOptions: {
			// Two pages rather than one with a route in it. The management code
			// then never reaches a participant: it is not in their bundle, not
			// in a chunk their bundle knows the name of, and on a deployment
			// with no administrator configured the server does not serve this
			// document at all — which a route inside the client could not be,
			// since both would be the same file.
			input: {
				index: resolve("./index.html"),
				admin: resolve("./admin.html"),
				account: resolve("./account.html"),
			},
		},
	},
	server: {
		port: 5173,

		// Explicitly IPv4, because `localhost` resolves to `::1` here and binding
		// only there leaves `http://127.0.0.1:5173` refusing connections. Bound to
		// `127.0.0.1` instead, both spellings reach it: a client given the name
		// tries `::1` first and falls back, which one given a literal address
		// cannot do.
		//
		// Loopback only. Another machine should be pointed at the server itself,
		// which serves the built client on one origin with the API and the
		// signalling; the dev server has no business being reachable.
		host: "127.0.0.1",

		proxy: {
			"/api": server,

			// Signalling, forwarded so the client can be developed against a
			// running server without knowing it lives somewhere else. `ws` because
			// this one is an upgrade rather than a request.
			"/rtc": { target: server, ws: true },
			"/twirp": server,
		},
	},
	test: {
		// The hooks under test render, so they need a document. Node alone would
		// fail on the first one with an error that says nothing about hooks.
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
	},
});
