import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";
import frappeui from "frappe-ui/vite";
import path from "path";

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
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
		// Prefer .ts over .js so that migrated TS modules (utils/call.ts,
		// offline/*.ts) win over any lingering .js shim at the same path.
		extensions: [".mjs", ".ts", ".js", ".mts", ".jsx", ".tsx", ".vue", ".json"],
	},
	optimizeDeps: {
		exclude: ["frappe-ui"],
	},
});
