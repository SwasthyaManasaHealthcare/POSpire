# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Static-file controllers for the Service Worker assets.

A Service Worker can only control URLs inside its own scope, and the SPA
mounts at `/pospire/...`. We need the SW served at the root path `/sw.js`
with `Service-Worker-Allowed: /` so it can claim scope `/`. The Vite build
plugin (frontend/vite-plugin-sw.js) mirrors the patched `sw.js` and the
`offline.html` fallback into `pospire/www/`. These two whitelisted GET
endpoints serve those files with the right Content-Type / scope headers.

Routing is set up in `hooks.py::website_route_rules`:
    /sw.js         -> pospire.pospire.api.sw.sw_js
    /offline.html  -> pospire.pospire.api.sw.offline_html

If the build artifacts are absent (e.g. dev environment that hasn't run
`npm run build`), both endpoints return 404 and SW registration silently
fails — same as before this controller was wired, no behavioural regression.
"""

from __future__ import annotations

from pathlib import Path

import frappe


def _www_path(filename: str) -> Path:
	"""Resolve `pospire/www/<filename>` for the running app installation."""
	return Path(frappe.get_app_path("pospire")) / "www" / filename


def _serve_static(filename: str, content_type: str, extra_headers: dict[str, str] | None = None) -> None:
	"""Read a file from `pospire/www/` and write it to `frappe.local.response`.

	Returns 404 (via raise_not_found) if the file is missing — typical when a
	developer hasn't run the production Vite build yet.
	"""
	path = _www_path(filename)
	if not path.is_file():
		frappe.local.response["http_status_code"] = 404
		frappe.local.response["message"] = f"{filename} not built — run `npm run build` in frontend/"
		return

	frappe.local.response["type"] = "binary"
	frappe.local.response["filename"] = filename
	frappe.local.response["filecontent"] = path.read_bytes()
	frappe.local.response["http_status_code"] = 200
	# Normalise the Frappe response-header bag (some code paths leave it None).
	headers = frappe.local.response.setdefault("headers", {})
	headers["Content-Type"] = content_type
	headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
	if extra_headers:
		headers.update(extra_headers)


@frappe.whitelist(allow_guest=True, methods=["GET"])
def sw_js() -> None:
	"""Serve the patched Service Worker at root scope.

	`Service-Worker-Allowed: /` is the critical header — without it the
	browser refuses to give the SW root scope when the file lives at /sw.js.
	"""
	_serve_static(
		"sw.js",
		content_type="application/javascript; charset=utf-8",
		extra_headers={"Service-Worker-Allowed": "/"},
	)


@frappe.whitelist(allow_guest=True, methods=["GET"])
def offline_html() -> None:
	"""Serve the JS-free offline fallback page."""
	_serve_static(
		"offline.html",
		content_type="text/html; charset=utf-8",
	)
