// Navidrome integration adapter (Subsonic API).
//
// Surfaces:
//   - searchProviders.music — searches artists, albums and songs
//   - widgets.player — plays a song from search in Holm, through proxy.stream
//
// Auth is Subsonic token auth: every call sends t = md5(password + salt) and
// the salt. Holm takes the password once, computes the token with a random
// salt in `prepareConfig`, and stores only the username, salt and token, so
// the password itself never reaches the database. The token is encrypted at
// rest like any secret, but it works for the Subsonic API until the password
// changes, and with the salt beside it a weak password can be brute-forced.

import { createHash, randomBytes } from 'node:crypto';

const API_VERSION = '1.16.1';

// Song results are capped lower than albums: a title search matches many
// tracks and buries the album.
const SONG_SHARE = 0.4;

// Covers render 174 CSS px tall; 3x covers phone screens.
const COVER_SIZE = 520;

const COVER_ID = /^[A-Za-z0-9_-]+$/;

/** @type {import('./_types.js').IntegrationAdapter} */
const adapter = {
	id: 'navidrome',
	name: 'Navidrome',
	icon: 'di:navidrome',
	shortcut: 'nd',
	description: 'Music server — search artists, albums and songs',

	configSchema: [
		{
			key: 'url',
			type: 'url',
			label: 'Navidrome URL',
			required: true,
			placeholder: 'https://music.example.com',
			help: 'Base URL of your Navidrome server',
			fromOperatorDefault: 'default_url'
		},
		{ key: 'username', type: 'text', label: 'Username', required: true },
		{
			key: 'password',
			type: 'secret',
			label: 'Password',
			help: 'Your Navidrome password. Holm uses it once to compute a Subsonic token and doesn’t store it. Leave empty to keep the current token.',
			// Spaces at either end are part of the password.
			trim: false
		},
		// Computed from the password in prepareConfig, never typed. The token
		// is labelled Password so a save without one reads "Missing required
		// field: Password".
		{ key: 'salt', type: 'text', label: 'Salt', hidden: true },
		{ key: 'token', type: 'secret', label: 'Password', required: true, hidden: true },
		{ key: 'tokenUser', type: 'text', label: 'Token user', hidden: true }
	],

	// Swaps a submitted password for a salted token before saving. Without a
	// new password the stored token is kept, so editing the URL alone works,
	// unless the username changed: that token belongs to the old user, so it
	// is dropped and the save asks for the password.
	prepareConfig({ config }) {
		const { password, ...rest } = config;
		if (password) return { ...rest, ...tokenFor(password), tokenUser: rest.username };
		if (rest.tokenUser !== rest.username) {
			const { token, salt, tokenUser, ...keep } = rest;
			return keep;
		}
		return rest;
	},

	async test({ config, fetch }) {
		if (!config?.url || !config?.username || !(config.password || config.token)) {
			return { ok: false, message: 'URL, username and password are required' };
		}
		try {
			const res = await subsonic(config, 'ping', {}, fetch);
			if (!res.ok) return { ok: false, message: `Server returned ${res.status} ${res.statusText}` };
			const body = (await res.json())?.['subsonic-response'];
			if (body?.status === 'ok') return { ok: true, message: `Signed in as ${config.username}` };
			// 40 is Subsonic's "wrong username or password".
			if (body?.error?.code === 40) return { ok: false, message: 'Wrong username or password' };
			return { ok: false, message: body?.error?.message || 'Navidrome sent an unexpected reply' };
		} catch (err) {
			return { ok: false, message: `Connection failed: ${err.message}` };
		}
	},

	searchProviders: {
		music: {
			label: 'Music',
			kind: 'media',
			// All music: compact cover-and-title cards, not posters.
			layout: 'tracks',
			mode: 'inline',
			async query({ config, query, limit, fetch, publicUrl }) {
				if (!config?.url || !config?.token) return { results: [] };
				const trimmed = (query || '').trim();
				if (!trimmed) return { results: [] };

				const max = Math.min(limit || 10, 25);
				const songs = Math.max(1, Math.floor(max * SONG_SHARE));
				const res = await subsonic(
					config,
					'search3',
					{ query: trimmed, artistCount: String(max), albumCount: String(max), songCount: String(songs) },
					fetch
				);
				if (!res.ok) {
					throw new Error(`Navidrome search failed: ${res.status}`);
				}
				const body = (await res.json())?.['subsonic-response'];
				if (body?.status !== 'ok') {
					throw new Error(`Navidrome search failed: ${body?.error?.message || 'unexpected reply'}`);
				}
				const found = body.searchResult3 || {};
				const base = linkBase(config, publicUrl);
				const items = [
					...(found.artist || []).map((a) => ({
						id: a.id,
						title: a.name,
						subtitle: 'Artist',
						cover: a.coverArt,
						href: `${base}/app/#/artist/${encodeURIComponent(a.id)}/show`
					})),
					...(found.album || []).map((a) => ({
						id: a.id,
						title: a.name || a.title,
						subtitle: ['Album', a.artist, a.year].filter(Boolean).join(' · '),
						cover: a.coverArt,
						href: `${base}/app/#/album/${encodeURIComponent(a.id)}/show`
					})),
					...(found.song || []).map((s) => ({
						id: s.id,
						title: s.title,
						subtitle: ['Song', s.artist, s.album].filter(Boolean).join(' · '),
						cover: s.coverArt,
						href: s.albumId ? `${base}/app/#/album/${encodeURIComponent(s.albumId)}/show` : `${base}/app/`,
						song: s
					}))
				];
				return {
					results: items.slice(0, max).map((item) => {
						const thumbnail =
							item.cover && COVER_ID.test(item.cover)
								? `/api/integrations/navidrome/proxy/cover/${encodeURIComponent(item.cover)}`
								: undefined;
						// A song plays in Holm's own player, through the stream proxy.
						const track = item.song && COVER_ID.test(item.song.id)
							? {
								title: item.title || 'Untitled',
								artist: item.song.artist || '',
								duration: Number(item.song.duration) || 0,
								stream: `/api/integrations/navidrome/proxy/stream/${encodeURIComponent(item.song.id)}`,
								cover: thumbnail
							}
							: undefined;
						return {
							id: String(item.id),
							title: item.title || 'Untitled',
							subtitle: item.subtitle,
							thumbnail,
							href: item.href,
							meta: track ? { kind: 'media', track } : { kind: 'media' }
						};
					})
				};
			}
		}
	},

	proxy: {
		cover: {
			defaultCacheControl: 'private, max-age=86400',
			async fetch({ config, params, fetch }) {
				const id = params.path?.[0];
				if (!id || !COVER_ID.test(id)) {
					return new Response('Invalid cover id', { status: 400 });
				}
				return subsonic(config, 'getCoverArt', { id, size: String(COVER_SIZE) }, fetch);
			}
		},
		// The original file, not a transcode, so Navidrome answers Range
		// requests: Safari won't play audio from a server that doesn't.
		stream: {
			stream: true,
			defaultCacheControl: 'private, no-store',
			async fetch({ config, params, request, fetch }) {
				const id = params.path?.[0];
				if (!id || !COVER_ID.test(id)) {
					return new Response('Invalid song id', { status: 400 });
				}
				const range = request.headers.get('range');
				return subsonic(config, 'stream', { id, format: 'raw' }, fetch, range ? { range } : {});
			}
		}
	},

	// Off unless the operator sets `surfaces.widgets: true` and the user turns
	// it on; without it a song opens in Navidrome like any other result.
	widgets: {
		player: { label: 'Player', description: 'Play songs from search in a corner player' }
	}
};

// An operator-set address that ends up in an href: plain http(s) only.
function safePublicUrl(value) {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const u = new URL(value.trim());
		return u.protocol === 'http:' || u.protocol === 'https:' ? stripTrailingSlash(u.href) : null;
	} catch {
		return null;
	}
}

function stripTrailingSlash(url) {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Where result links point. Holm talks to `config.url`, but the person's
// browser may reach Navidrome at a different address: the operator's
// `public_url` wins when there is one (see safePublicUrl).
function linkBase(config, publicUrl) {
	return safePublicUrl(publicUrl) || stripTrailingSlash(config.url);
}

function tokenFor(password) {
	const salt = randomBytes(8).toString('hex');
	return { salt, token: createHash('md5').update(password + salt).digest('hex') };
}

// A test before Connect still has the typed password; afterwards only the
// stored salt and token exist.
function subsonic(config, method, extra, fetch, headers = { accept: 'application/json' }) {
	const auth = config.password ? tokenFor(config.password) : { salt: config.salt, token: config.token };
	const params = new URLSearchParams({
		u: config.username,
		t: auth.token || '',
		s: auth.salt || '',
		v: API_VERSION,
		c: 'Holm',
		f: 'json',
		...extra
	});
	return fetch(`${stripTrailingSlash(config.url)}/rest/${method}?${params}`, { headers });
}

export default adapter;
