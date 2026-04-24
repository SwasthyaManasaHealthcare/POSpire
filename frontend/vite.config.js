import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";
import frappeui from "frappe-ui/vite";
import path from "path";
import posspireServiceWorker from "./vite-plugin-sw.js";

export default defineConfig({
	plugins: [
		frappeui({
			frappeProxy: true,
			jinjaBootData: true,
			lucideIcons: true,
			frappeTypes: false,
			buildConfig: {
				indexHtmlPath: "../pospire/www/pospire.html",
				emptyOutDir: true,
				sourcemap: true,
			},
		}),
		vue(),
		vuetify({ autoImport: true }),
		// Injects BUILD_HASH + precache URL list into the emitted sw.js, and
		// mirrors sw.js + offline.html into ../pospire/www/ for root-scope
		// serving via a Frappe controller. See frontend/public/sw.js and
		// docs/offline/10-service-worker.md §2.2 for details.
		posspireServiceWorker({
			frappeAppRoot: "../pospire",
			baseUrl: "/assets/pospire/frontend/",
		}),
	],
	// Emit a manifest so downstream tooling (and a future Workbox-style
	// precache list generator) can enumerate the bundle without re-parsing HTML.
	build: {
		manifest: true,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	optimizeDeps: {
		exclude: ["frappe-ui"],
	},
});
