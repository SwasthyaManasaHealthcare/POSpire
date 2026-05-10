/**
 * vite-plugin-sw — post-processes the Service Worker for POSpire.
 *
 * What it does (PROD builds only):
 *   1. Walks the emitted Vite bundle and builds a REQUIRED precache list:
 *      every JS/CSS chunk, every copied asset, /offline.html, and critical
 *      fonts. Failure on any of these aborts SW install.
 *   2. Builds a BEST-EFFORT shell-route list (`/pospire/pos`, etc.). The
 *      install precaches these too, but tolerates failures (auth redirect,
 *      route disabled). Without them, hard-reload offline falls through to
 *      `/offline.html` instead of booting the cached SPA.
 *   3. Computes BUILD_HASH from the sorted precache list AND shell routes.
 *      Changing either invalidates the cache.
 *   4. Replaces `__BUILD_HASH__`, `__PRECACHE_URLS__`, and `__SHELL_ROUTES__`
 *      placeholders in the emitted sw.js chunk.
 *   5. Mirrors sw.js + offline.html into `../pospire/www/` so a Frappe
 *      controller serves them at root scope (/sw.js, /offline.html) per
 *      docs/offline/10-service-worker.md §2.2.
 *
 * DEV mode: no-op. main.js gates registration on import.meta.env.PROD, so the
 * dev server never exposes the SW.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ESM-compatible __dirname. Used to anchor the www/ mirror destination on
// the plugin file's location rather than on Vite's outDir (configurable).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SW_FILENAME = "sw.js";
const OFFLINE_FILENAME = "offline.html";

export default function posspireServiceWorkerPlugin(options = {}) {
	const frappeAppRoot = options.frappeAppRoot || "../pospire";
	const baseUrl = options.baseUrl || "/assets/pospire/frontend/";

	// Frappe-rendered SPA shell routes to precache (best-effort, sw.js install
	// tolerates failures here). All SPA paths route to the same template, so
	// caching one is enough for offline navigation fallback — but we cache
	// multiple to cover hard-reload after auth-redirect edge cases.
	const shellRoutes = options.shellRoutes || [
		"/pospire/pos",
		"/pospire/payments",
	];

	let outDir = null;
	let isProd = false;

	return {
		name: "pospire-sw",
		apply: "build",

		configResolved(config) {
			outDir = config.build.outDir;
			isProd = config.command === "build" && config.mode !== "development";
		},

		// After the bundle is written to disk, patch sw.js with the build hash
		// and precache URL list. We do this in writeBundle so the emitted file
		// includes every copied asset from Vite's `public/` folder as well.
		writeBundle(_options, bundle) {
			if (!isProd || !outDir) return;

			const swPath = path.join(outDir, SW_FILENAME);
			if (!fs.existsSync(swPath)) {
				this.warn(
					`[pospire-sw] sw.js not found at ${swPath}. Ensure frontend/public/sw.js exists.`,
				);
				return;
			}

			// Collect precache URLs from the bundle + public assets.
			const precacheUrls = new Set();
			precacheUrls.add("/" + OFFLINE_FILENAME);

			// Bundle chunks and assets. Skip source maps and the SW itself.
			for (const [fileName, chunk] of Object.entries(bundle)) {
				if (fileName === SW_FILENAME) continue;
				if (fileName === OFFLINE_FILENAME) continue;
				if (fileName.endsWith(".map")) continue;
				if (chunk.type === "chunk" || chunk.type === "asset") {
					// Skip index.html — we don't want to precache the raw Vite
					// index.html; the Frappe-rendered shell is served from the
					// app's root route.
					if (fileName === "index.html") continue;
					precacheUrls.add(baseUrl + fileName);
				}
			}

			// Critical fonts emitted by Vuetify / mdi-font live under assets/.
			// They're already captured by the loop above.

			// BUILD_HASH: stable SHA1 of the sorted precache list AND shell
			// routes. Changing either invalidates the cache, so a deploy that
			// adds a new SPA route forces clients to re-precache.
			const hashInput = [
				...Array.from(precacheUrls).sort(),
				"---shell---",
				...Array.from(shellRoutes).sort(),
			].join("\n");
			const buildHash = crypto
				.createHash("sha1")
				.update(hashInput)
				.digest("hex")
				.slice(0, 12);

			let swSource = fs.readFileSync(swPath, "utf8");

			swSource = swSource
				.replace(/"__BUILD_HASH__"/g, JSON.stringify(buildHash))
				.replace(
					/"__PRECACHE_URLS__"/g,
					JSON.stringify(JSON.stringify(Array.from(precacheUrls))),
				)
				.replace(
					/"__SHELL_ROUTES__"/g,
					JSON.stringify(JSON.stringify(Array.from(shellRoutes))),
				);

			fs.writeFileSync(swPath, swSource, "utf8");

			// Mirror the patched sw.js + offline.html into the Frappe app's
			// www/ directory. A tiny .py companion (pospire/www/sw.py and
			// pospire/www/offline.py) sets headers; Frappe's TemplatePage
			// renderer serves the file directly at /sw.js and /offline.html.
			//
			// Path resolution: __dirname here is the absolute path of
			// frontend/. The Frappe www/ dir is at ../pospire/www/ from there.
			// We anchor on __dirname (NOT outDir) because outDir is
			// configurable via vite.config and shouldn't decide where Python
			// templates live.
			try {
				const wwwDir = path.resolve(__dirname, frappeAppRoot, "www");
				if (!fs.existsSync(wwwDir)) {
					fs.mkdirSync(wwwDir, { recursive: true });
				}
				fs.copyFileSync(swPath, path.join(wwwDir, SW_FILENAME));
				const offlinePath = path.join(outDir, OFFLINE_FILENAME);
				if (fs.existsSync(offlinePath)) {
					fs.copyFileSync(offlinePath, path.join(wwwDir, OFFLINE_FILENAME));
				}
			} catch (err) {
				this.warn(`[pospire-sw] failed to mirror sw.js to Frappe www/: ${err.message}`);
			}

			// eslint-disable-next-line no-console
			console.log(
				`[pospire-sw] patched ${SW_FILENAME} (buildHash=${buildHash}, precache=${precacheUrls.size} urls, shellRoutes=${shellRoutes.length})`,
			);
		},
	};
}
