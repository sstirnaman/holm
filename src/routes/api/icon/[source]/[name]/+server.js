// GET /api/icon/:source/:name
//
// Same-origin cache in front of the public icon CDNs, so a dashboard load
// costs one round-trip to Holm instead of ~40 to jsdelivr/simpleicons, and
// visitors' IPs and Referer never reach those CDNs. Only the three known
// sources and plain slugs are accepted: this is not an open proxy.
//
// Local first: <ICON_LIBRARY_DIR>/<source>/<name>.svg (default ./icon-library,
// i.e. /app/icon-library), then, for si, the Simple Icons package Holm bundles.
// Only after that does it go online, and `icons.source: local` never does.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfig } from '$lib/server/config.js';
import { simpleIconSvg } from '$lib/server/brandColors.js';

async function localIcon(source, name) {
	try {
		return await readFile(join(resolve(process.env.ICON_LIBRARY_DIR || 'icon-library'), source, `${name}.svg`));
	} catch {
		// No file for it: try the bundled set, then the web.
	}
	return source === 'si' ? simpleIconSvg(name.toLowerCase()) : null;
}

const SOURCES = {
	di: (name) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${name}.svg`,
	si: (name) => `https://cdn.simpleicons.org/${name}`,
	lucide: (name) => `https://cdn.jsdelivr.net/npm/lucide-static/icons/${name}.svg`
};
const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const MAX_ENTRIES = 500;
const TTL_MS = 24 * 60 * 60 * 1000;
// Real icons are a few KB; the cap bounds the cache at MAX_ENTRIES × 64 KB.
const MAX_BYTES = 64 * 1024;

// key → { status, body, type, ts }. Real misses (404/410) are cached too:
// simpleicons is tried as a mono fallback for every app and 404s for many of
// them. Rate limits, 5xx and network errors are not.
const cache = new Map();

// Concurrent requests for the same uncached icon share one upstream fetch.
const inFlight = new Map();

async function fetchIcon(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
		if (res.ok) {
			const body = await res.arrayBuffer();
			if (body.byteLength <= MAX_BYTES) {
				return { status: 200, body, type: res.headers.get('content-type') || 'image/svg+xml', ts: Date.now() };
			}
		} else if (res.status === 404 || res.status === 410) {
			return { status: 404, ts: Date.now() };
		}
	} catch {
		// Network failure or timeout: handled by the caller like any transient error.
	}
	return null;
}

// Upstream SVGs are third-party content served from our origin; sandbox them
// so opening one directly can't run script as Holm.
const SVG_HEADERS = {
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
	'x-content-type-options': 'nosniff'
};

export async function GET({ params }) {
	const toUrl = SOURCES[params.source];
	const name = params.name.replace(/\.svg$/i, '');
	if (!toUrl || !SLUG.test(name)) return new Response('Not found', { status: 404 });

	const local = await localIcon(params.source, name);
	if (local) {
		return new Response(local, {
			headers: { ...SVG_HEADERS, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' }
		});
	}
	if (getConfig().icons?.source === 'local') {
		return new Response('Not found', { status: 404, headers: { 'cache-control': 'public, max-age=3600' } });
	}

	const key = `${params.source}:${name}`;
	let entry = cache.get(key);
	if (!entry || Date.now() - entry.ts > TTL_MS) {
		let pending = inFlight.get(key);
		if (!pending) {
			pending = fetchIcon(toUrl(name)).finally(() => inFlight.delete(key));
			inFlight.set(key, pending);
		}
		const fresh = await pending;
		if (fresh) {
			entry = fresh;
			cache.delete(key);
			cache.set(key, entry);
			if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
		} else if (!entry) {
			// Transient upstream trouble: serve a stale copy if there is one,
			// otherwise fail without letting the browser cache the failure.
			return new Response('Icon unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
		}
	}

	if (entry.status !== 200) {
		return new Response('Not found', { status: 404, headers: { 'cache-control': 'public, max-age=3600' } });
	}
	return new Response(entry.body, {
		headers: {
			...SVG_HEADERS,
			'content-type': entry.type,
			'cache-control': 'public, max-age=86400, stale-while-revalidate=604800'
		}
	});
}
