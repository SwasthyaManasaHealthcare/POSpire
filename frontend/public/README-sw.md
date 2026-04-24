# POSpire Service Worker (Agent 4)

Scope: app shell only. Never caches `/api/method/*` or `/api/resource/*`. See
`docs/offline/01-architecture-principles.md` (P-3) and
`docs/offline/10-service-worker.md` for the full spec.

## Files

| Path | Role |
|---|---|
| `frontend/public/sw.js` | Source Service Worker. Contains placeholders `__BUILD_HASH__` and `__PRECACHE_URLS__`. Not served directly. |
| `frontend/public/offline.html` | Minimal fallback page (no JS, no bundle). Served when shell isn't cached yet. |
| `frontend/src/offline/registerServiceWorker.js` | Registers `/sw.js` at root scope in PROD only. Shows a non-blocking update toast on `NEW_VERSION_AVAILABLE`. |
| `frontend/vite-plugin-sw.js` | Build-time plugin that injects `BUILD_HASH` + precache URL list, then mirrors `sw.js` / `offline.html` into `pospire/www/`. |

## How BUILD_HASH is injected

At build time (`vite build`) the plugin in `frontend/vite-plugin-sw.js`:

1. Walks the emitted bundle and builds a precache URL list (every hashed
   JS/CSS chunk plus assets, scoped to the Vite `base` URL
   `/assets/pospire/frontend/`).
2. Computes a 12-char SHA-1 over the sorted URL list — this is `BUILD_HASH`.
   It changes whenever any shell file changes (because Vite emits
   content-hashed filenames).
3. Replaces the placeholder strings `"__BUILD_HASH__"` and
   `"__PRECACHE_URLS__"` inside the emitted `sw.js`.
4. Copies the patched `sw.js` plus `offline.html` into
   `pospire/www/` so Frappe's website layer can serve them.

If the placeholders are ever left unreplaced (e.g. someone loads `sw.js`
directly from the dev server), the SW falls back to `BUILD_HASH = "dev"` and
`PRECACHE_URLS = ["/offline.html"]`. Registration is gated on `import.meta.env.PROD`
in `main.js`, so this path should not occur in practice.

## Serving `/sw.js` and `/offline.html` at root scope (REQUIRED)

A Service Worker can only control URLs inside its own scope. Served from
`/assets/pospire/frontend/sw.js` it would only control `/assets/pospire/frontend/*`,
which is useless — the SPA mounts at `/pospire/*`. Options, in order of
preference (per `docs/offline/10-service-worker.md` §2.2):

### Option A — Frappe whitelisted controller (preferred, not yet wired)

Add to `pospire/pospire/api/offline.py`:

```python
import frappe
from pathlib import Path

@frappe.whitelist(allow_guest=True, methods=["GET"])
def sw_js() -> None:
    path = Path(frappe.get_app_path("pospire")) / "www" / "sw.js"
    frappe.local.response.type = "binary"
    frappe.local.response.filename = "sw.js"
    frappe.local.response.filecontent = path.read_bytes()
    frappe.local.response.headers["Content-Type"] = "application/javascript"
    frappe.local.response.headers["Service-Worker-Allowed"] = "/"
    frappe.local.response.headers["Cache-Control"] = "no-cache"


@frappe.whitelist(allow_guest=True, methods=["GET"])
def offline_html() -> None:
    path = Path(frappe.get_app_path("pospire")) / "www" / "offline.html"
    frappe.local.response.type = "binary"
    frappe.local.response.filename = "offline.html"
    frappe.local.response.filecontent = path.read_bytes()
    frappe.local.response.headers["Content-Type"] = "text/html; charset=utf-8"
```

And add to `pospire/hooks.py`:

```python
website_route_rules = [
    {"from_route": "/pospire/<path:app_path>", "to_route": "pospire"},
    {"from_route": "/sw.js", "to_route": "pospire.pospire.api.offline.sw_js"},
    {"from_route": "/offline.html", "to_route": "pospire.pospire.api.offline.offline_html"},
]
```

**This is out-of-scope for Agent 4** (the task is the SW itself). The spec's
§2.2.2 spike validates Option A on staging before Phase 6.

### Option B / C / D

See `docs/offline/10-service-worker.md` §2.2.1. Option B uses
`website_route_rules` with a header hook; Option C puts the rule in
nginx/Caddy; Option D ships without SW (degraded mode — offline shell
unavailable).

## Update lifecycle

1. New build deployed. Browser fetches `/sw.js`, byte-compares to the old one;
   if different, installs.
2. On `install`, the new SW precaches under `pospire-shell-v{newHash}`. If any
   precache URL fails, the install rejects and the **old cache stays live**.
3. On `activate`, caches whose name starts with `pospire-shell-v` and isn't
   the current one are deleted. The new SW `postMessage`s
   `NEW_VERSION_AVAILABLE` to all controlled clients.
4. `registerServiceWorker.js` listens for this and displays a non-blocking
   toast "Update available — reload to apply". No auto-reload.

## Manual "Update now"

The SPA can postMessage `{ type: "SKIP_WAITING" }` to `navigator.serviceWorker.controller`
to force activation. Use for the admin panel "Update now" action (§5.4).

## Disabling SW

```js
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(keys => keys.filter(k => k.startsWith("pospire-shell-v"))
  .forEach(k => caches.delete(k)));
```

## Known gaps

- Frappe controller for `/sw.js` + `/offline.html` routing is **not** in this
  commit. It needs to ship alongside the SW before a production deploy.
- CSP headers: if a deployment sets a strict CSP without `worker-src 'self'`,
  registration silently fails. Deployment playbook must include the CSP
  adjustment (see spec §6).
- No test harness included yet; §9 of the spec lists the matrix to cover
  before Phase 6.
