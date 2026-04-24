/**
 * POSpire Service Worker — shell-only (P-3)
 *
 * Responsibilities (see docs/offline/10-service-worker.md):
 *   1. Precache the compiled Vite app shell (HTML / JS / CSS / fonts / critical images)
 *      plus /offline.html on install.
 *   2. Serve shell assets cache-first with a background network revalidation.
 *   3. Serve navigation requests from the cached shell when offline; fall back to
 *      /offline.html when the shell isn't cached yet (first-ever visit offline).
 *   4. NEVER touch /api/method/* or /api/resource/* — those are Dexie's job.
 *   5. Version caches by build hash; never discard the working cache until the
 *      new versioned cache is fully installed.
 *   6. On successful activation, postMessage NEW_VERSION_AVAILABLE to every client.
 *
 * Hard constraints (P-3):
 *   - No API response caching here, ever. A failed API call surfaces to the
 *     offline adapter, which owns fallback semantics.
 *   - A failed precache MUST abort the install — the old cache stays live.
 *   - skipWaiting() only runs after the new cache is fully populated.
 */

/* eslint-env serviceworker */
/* global self, caches, clients, fetch, Response, URL */

// BUILD_HASH is substituted at build time. See scripts/inject-sw-build-hash.js
// (or the Vite plugin when one is wired). During local dev with Vite, the SW is
// NOT registered (main.js gates registration on import.meta.env.PROD), so the
// placeholder never reaches a live browser. If it does leak through, the
// `dev` sentinel below keeps behaviour sane instead of producing the literal
// string "__BUILD_HASH__" as a cache key.
const RAW_BUILD_HASH = "__BUILD_HASH__";
const BUILD_HASH =
	RAW_BUILD_HASH && RAW_BUILD_HASH !== "__BUILD" + "_HASH__" ? RAW_BUILD_HASH : "dev";

const SHELL_CACHE = `pospire-shell-v${BUILD_HASH}`;
const CACHE_PREFIX = "pospire-shell-v";
const OFFLINE_URL = "/offline.html";

// PRECACHE_URLS is appended to at build time with the Vite manifest entries.
// The placeholder below is replaced by a JSON array of public paths — see
// scripts/inject-sw-build-hash.js. At minimum, /offline.html is always present
// so hard-reloads on first-visit offline still render a useful page.
const INJECTED_PRECACHE = "__PRECACHE_URLS__";
const PRECACHE_URLS = (() => {
	if (
		INJECTED_PRECACHE &&
		INJECTED_PRECACHE !== "__PRECACHE" + "_URLS__" &&
		INJECTED_PRECACHE.startsWith("[")
	) {
		try {
			const parsed = JSON.parse(INJECTED_PRECACHE);
			if (Array.isArray(parsed)) {
				return Array.from(new Set([OFFLINE_URL, ...parsed]));
			}
		} catch (err) {
			// fall through to the defaults — the install will still succeed with
			// just /offline.html. Log at install time, not at parse time.
			self.__SW_PRECACHE_PARSE_ERROR__ = err && err.message;
		}
	}
	return [OFFLINE_URL];
})();

// Paths the SW must never intercept. Passed through to network on every fetch.
const API_PASSTHROUGH_PREFIXES = ["/api/method/", "/api/resource/", "/api/v2/"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
	// Use warn to survive default DevTools filters; SW logs are low-volume.
	// eslint-disable-next-line no-console
	console.warn("[pospire-sw]", ...args);
}

function isApiRequest(url) {
	return API_PASSTHROUGH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isNavigationRequest(request) {
	if (request.mode === "navigate") {
		return true;
	}
	// Fallback for older browsers: HTML documents requested at top level.
	return (
		request.method === "GET" &&
		request.headers.get("accept") &&
		request.headers.get("accept").includes("text/html")
	);
}

function isShellAsset(url) {
	// Vite emits hashed assets under /assets/. We also accept common font
	// extensions and the root index.html.
	if (url.pathname === "/" || url.pathname.endsWith("/index.html")) {
		return true;
	}
	if (url.pathname.startsWith("/assets/")) {
		return true;
	}
	if (/\.(?:js|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|gif|webp|ico)$/.test(url.pathname)) {
		// Only treat app assets as shell — Frappe-served assets under
		// /files/ are user content and should pass through.
		if (!url.pathname.startsWith("/files/")) {
			return true;
		}
	}
	return false;
}

async function broadcastToClients(message) {
	try {
		const all = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
		for (const client of all) {
			client.postMessage(message);
		}
	} catch (err) {
		log("broadcast failed", err);
	}
}

// ---------------------------------------------------------------------------
// Install — build the new versioned cache. Abort on any failure; the old
// SW/cache stays live because we never touched it.
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(SHELL_CACHE);

			// Precache with explicit per-URL handling so a single 404 doesn't
			// poison the whole install silently. addAll() rejects on any
			// failure, which is what we want, but the default error is opaque.
			const results = await Promise.allSettled(
				PRECACHE_URLS.map(async (url) => {
					// Bypass HTTP cache so we grab the freshly-deployed asset,
					// not a stale entry left over from an earlier SW generation.
					const req = new Request(url, { cache: "reload", credentials: "same-origin" });
					const res = await fetch(req);
					if (!res.ok) {
						throw new Error(`precache ${url} -> HTTP ${res.status}`);
					}
					await cache.put(url, res.clone());
				}),
			);

			const failures = results
				.map((r, i) => (r.status === "rejected" ? `${PRECACHE_URLS[i]}: ${r.reason}` : null))
				.filter(Boolean);

			if (failures.length) {
				// Drop the half-filled cache so activate() doesn't promote it.
				await caches.delete(SHELL_CACHE);
				log("install failed — keeping previous cache intact", failures);
				throw new Error(`precache failed: ${failures.join("; ")}`);
			}

			log("install complete", { cache: SHELL_CACHE, entries: PRECACHE_URLS.length });
			// skipWaiting() is opt-in; we call it here because the new cache is
			// proven-complete at this point (install only reaches this line on
			// success). Clients are still notified via NEW_VERSION_AVAILABLE so
			// the UI can prompt the user to reload on their own schedule.
			await self.skipWaiting();
		})(),
	);
});

// ---------------------------------------------------------------------------
// Activate — claim clients and prune OLD pospire caches. Never prune the
// current SHELL_CACHE even if it looks stale; the new SW only reaches
// activate() after install() wrote it, so by definition it's current.
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(
				names
					.filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
					.map((name) => caches.delete(name)),
			);

			await self.clients.claim();
			await broadcastToClients({
				type: "NEW_VERSION_AVAILABLE",
				buildHash: BUILD_HASH,
				cache: SHELL_CACHE,
			});

			log("activate complete", { cache: SHELL_CACHE });
		})(),
	);
});

// ---------------------------------------------------------------------------
// Fetch — routing per docs/offline/10-service-worker.md §4.
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
	const { request } = event;

	// SW only handles GET. Non-GETs (POST for writes, etc.) always go to network.
	if (request.method !== "GET") {
		return;
	}

	let url;
	try {
		url = new URL(request.url);
	} catch {
		return;
	}

	// Never intercept cross-origin; let the browser handle it.
	if (url.origin !== self.location.origin) {
		return;
	}

	// P-3 non-negotiable: APIs always go to network, untouched.
	if (isApiRequest(url)) {
		return;
	}

	if (isNavigationRequest(request)) {
		event.respondWith(handleNavigation(request));
		return;
	}

	if (isShellAsset(url)) {
		event.respondWith(handleShellAsset(request));
		return;
	}

	// Everything else (Frappe /files/, /app routes we don't own, etc.): pass through.
});

async function handleNavigation(request) {
	// Network-first for navigations so the cashier sees fresh HTML when online.
	// On failure, serve the cached shell — this is what enables the offline SPA
	// boot. If no shell cached (first-visit-offline), serve /offline.html.
	try {
		const fresh = await fetch(request);
		// Opportunistically refresh the cached shell copy — but only for
		// successful, same-origin HTML responses.
		if (fresh && fresh.ok && fresh.type === "basic") {
			const cache = await caches.open(SHELL_CACHE);
			cache.put(request, fresh.clone()).catch(() => {
				/* cache quota or opaque response — safe to ignore */
			});
		}
		return fresh;
	} catch (err) {
		const cache = await caches.open(SHELL_CACHE);
		const cachedShell = await cache.match(request, { ignoreSearch: true });
		if (cachedShell) {
			log("nav offline — served cached shell", request.url);
			return cachedShell;
		}
		// Try any cached navigation we have — same-origin HTML — before the
		// offline fallback. This handles /pospire/pos vs /pospire/payments etc.
		const rootShell = await cache.match("/");
		if (rootShell) {
			log("nav offline — served root shell", request.url);
			return rootShell;
		}
		const fallback = await cache.match(OFFLINE_URL);
		if (fallback) {
			log("nav offline — served /offline.html", request.url);
			return fallback;
		}
		log("nav offline — no shell and no offline fallback", err);
		return new Response(
			"<!doctype html><title>Offline</title><p>You are offline. Please reconnect.</p>",
			{
				status: 503,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			},
		);
	}
}

async function handleShellAsset(request) {
	// Cache-first with background revalidation (stale-while-revalidate for the
	// shell). This is safe because Vite emits content-hashed filenames — a new
	// build produces new URLs, so stale cached copies can't shadow fresh code.
	const cache = await caches.open(SHELL_CACHE);
	const cached = await cache.match(request);

	const networkFetch = fetch(request)
		.then((res) => {
			if (res && res.ok && res.type === "basic") {
				cache.put(request, res.clone()).catch(() => {
					/* safe to drop */
				});
			}
			return res;
		})
		.catch((err) => {
			// If we have cached content, this is fine — swallow and let the
			// cached copy serve. Otherwise, bubble up so the browser shows a
			// network error, which is the honest answer.
			if (cached) {
				return null;
			}
			throw err;
		});

	if (cached) {
		// Kick off revalidation but don't block the response.
		networkFetch.catch(() => {
			/* already handled */
		});
		return cached;
	}

	return networkFetch;
}

// ---------------------------------------------------------------------------
// Message channel — lets the SPA ask the SW to skipWaiting on demand (manual
// "Update now" button in the offline admin panel per §5.4 of the spec).
// ---------------------------------------------------------------------------

self.addEventListener("message", (event) => {
	if (!event.data || typeof event.data !== "object") {
		return;
	}
	if (event.data.type === "SKIP_WAITING") {
		self.skipWaiting();
	}
	if (event.data.type === "GET_VERSION") {
		if (event.source && typeof event.source.postMessage === "function") {
			event.source.postMessage({ type: "SW_VERSION", buildHash: BUILD_HASH });
		}
	}
});
