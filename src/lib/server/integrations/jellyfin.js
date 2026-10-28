// Jellyfin integration adapter.
//
// Surfaces:
//   - searchProviders.media — searches movies, shows, episodes, albums and artists
//
// Auth is Quick Connect: Holm shows a code, the user approves it in their
// own Jellyfin session, and Holm keeps that user's access token. No API key
// (those are server-wide and see every library) and no password (Jellyfin
// signs in with the LLDAP password, which unlocks every other app too).
// Tokens go in `Authorization: MediaBrowser …, Token="..."`; the X-Emby-Token
// header and api_key query param are legacy and off by default in 12.0.

// Item kinds searched, and how each one reads in the subtitle. Episodes are
// left out: a title search matches dozens of them and buries the show.
const ITEM_TYPES = {
	Movie: 'Movie',
	Series: 'Show',
	MusicAlbum: 'Album',
	MusicArtist: 'Artist'
};

const VIDEO_TYPES = new Set(['Movie', 'Series']);

// Posters render 174 CSS px tall; 3x covers phone screens.
const POSTER_HEIGHT = 520;

// Jellyfin item ids are GUIDs, serialised as 32 hex chars (or dashed).
const ITEM_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** @type {import('./_types.js').IntegrationAdapter} */
const adapter = {
	id: 'jellyfin',
	name: 'Jellyfin',
	icon: 'di:jellyfin',
	shortcut: 'jf',
	description: 'Media server — search movies, shows and music',

	configSchema: [
		{
			key: 'url',
			type: 'url',
			label: 'Jellyfin URL',
			required: true,
			placeholder: 'https://jellyfin.example.com',
			help: 'Base URL of your Jellyfin server',
			fromOperatorDefault: 'default_url'
		},
		// Filled in by Quick Connect, never typed.
		{ key: 'accessToken', type: 'secret', label: 'Access token', required: true, hidden: true },
		{ key: 'userId', type: 'text', label: 'User id', hidden: true },
		{ key: 'userName', type: 'text', label: 'User', hidden: true },
		{ key: 'deviceId', type: 'text', label: 'Device id', hidden: true }
	],

	signIn: {
		label: 'Sign in with Quick Connect',
		help: 'In Jellyfin, open your **profile → Quick Connect** and enter this code.',

		async start({ config, fetch, publicUrl }) {
			const base = stripTrailingSlash(config.url);
			// One device id per sign-in: Jellyfin keeps one session per device,
			// so this shows up as its own "Holm" entry under Devices.
			const deviceId = `holm-${crypto.randomUUID()}`;
			const headers = authHeaders({ deviceId });
			const enabled = await fetch(`${base}/QuickConnect/Enabled`, { headers });
			if (!enabled.ok) return { error: `Jellyfin returned ${enabled.status} — is the URL right?` };
			if ((await enabled.json()) !== true) {
				return { error: 'Quick Connect is turned off on this server (Dashboard → General → Quick Connect)' };
			}
			const res = await fetch(`${base}/QuickConnect/Initiate`, { method: 'POST', headers });
			if (!res.ok) return { error: `Couldn’t start Quick Connect (${res.status})` };
			const data = await res.json();
			if (!data?.Secret || !data?.Code) return { error: 'Jellyfin sent an unexpected reply' };
			return { code: String(data.Code), link: `${linkBase(config, publicUrl)}/web/#/quickconnect`, state: { secret: data.Secret, deviceId } };
		},

		async poll({ config, state, fetch }) {
			const base = stripTrailingSlash(config.url);
			const headers = authHeaders({ deviceId: state.deviceId });
			const res = await fetch(`${base}/QuickConnect/Connect?secret=${encodeURIComponent(state.secret)}`, { headers });
			// Jellyfin forgets a code after ~10 minutes and then 404s it.
			if (res.status === 404) return { status: 'error', error: 'The code expired — start again' };
			if (!res.ok) return { status: 'error', error: `Jellyfin returned ${res.status}` };
			if (!(await res.json())?.Authenticated) return { status: 'pending' };

			const auth = await fetch(`${base}/Users/AuthenticateWithQuickConnect`, {
				method: 'POST',
				headers: { ...headers, 'content-type': 'application/json' },
				body: JSON.stringify({ Secret: state.secret })
			});
			if (!auth.ok) return { status: 'error', error: `Sign-in failed (${auth.status})` };
			const session = await auth.json();
			if (!session?.AccessToken || !session?.User?.Id) {
				return { status: 'error', error: 'Jellyfin sent an unexpected reply' };
			}
			return {
				status: 'done',
				config: {
					accessToken: session.AccessToken,
					userId: session.User.Id,
					userName: session.User.Name || '',
					deviceId: state.deviceId
				}
			};
		}
	},

	// Ends the Holm session in Jellyfin, so the token stops working.
	async signOut({ config, fetch }) {
		if (!config?.url || !config?.accessToken) return;
		await fetch(`${stripTrailingSlash(config.url)}/Sessions/Logout`, {
			method: 'POST',
			headers: authHeaders(config)
		});
	},

	async test({ config, fetch }) {
		if (!config?.url || !config?.accessToken) {
			return { ok: false, message: 'Sign in with Quick Connect first' };
		}
		const base = stripTrailingSlash(config.url);
		try {
			const res = await fetch(`${base}/Users/Me`, { method: 'GET', headers: authHeaders(config) });
			if (!res.ok) {
				if (res.status === 401 || res.status === 403) {
					return { ok: false, message: 'Session ended in Jellyfin — sign in again' };
				}
				return { ok: false, message: `Server returned ${res.status} ${res.statusText}` };
			}
			const me = await res.json();
			return { ok: true, message: `Signed in as ${me?.Name || config.userName || 'Jellyfin user'}` };
		} catch (err) {
			return { ok: false, message: `Connection failed: ${err.message}` };
		}
	},

	searchProviders: {
		media: {
			label: 'Media',
			kind: 'media',
			shelf: 'video',
			mode: 'inline',
			async query({ config, query, limit, fetch, publicUrl }) {
				if (!config?.url || !config?.accessToken) return { results: [] };
				const trimmed = (query || '').trim();
				if (!trimmed) return { results: [] };

				const base = stripTrailingSlash(config.url);
				// /Items with userId applies that user's library access and
				// parental rating. Everything else we read (year, album artist,
				// image tags, ServerId) is in the default DTO.
				const params = new URLSearchParams({
					userId: config.userId || '',
					searchTerm: trimmed,
					Recursive: 'true',
					IncludeItemTypes: Object.keys(ITEM_TYPES).join(','),
					Limit: String(Math.min(limit || 10, 25)),
					EnableTotalRecordCount: 'false',
					Fields: 'ProviderIds',
					EnableImageTypes: 'Primary',
					ImageTypeLimit: '1'
				});
				const res = await fetch(`${base}/Items?${params}`, {
					method: 'GET',
					headers: authHeaders(config)
				});
				if (!res.ok) {
					throw new Error(`Jellyfin search failed: ${res.status}`);
				}
				const data = await res.json();
				const items = data?.Items || [];
				return {
					results: items.map((item) => {
						const imageId = primaryImageId(item);
						const server = item.ServerId ? `&serverId=${encodeURIComponent(item.ServerId)}` : '';
						return {
							id: item.Id,
							title: item.Name || 'Untitled',
							subtitle: subtitleFor(item),
							thumbnail: imageId
								? `/api/integrations/jellyfin/proxy/image/${encodeURIComponent(imageId)}?maxHeight=${POSTER_HEIGHT}`
								: undefined,
							href: `${linkBase(config, publicUrl)}/web/#/details?id=${encodeURIComponent(item.Id)}${server}`,
							// Movies and shows open a detail view; Play is its button.
							...(VIDEO_TYPES.has(item.Type) ? { openLabel: 'Play', detail: { id: item.Id } } : {}),
							meta: { kind: 'media', tmdb: tmdbKey(item) }
						};
					})
				};
			}
		}
	},

	async details({ config, params, fetch }) {
		const id = params?.id;
		if (typeof id !== 'string' || !ITEM_ID.test(id)) return null;
		const base = stripTrailingSlash(config.url);
		// userId applies the user's library access, as in search.
		const res = await fetch(`${base}/Items/${id}?userId=${encodeURIComponent(config.userId || '')}`, {
			headers: authHeaders(config)
		});
		if (!res.ok) throw new Error(`Jellyfin returned ${res.status}`);
		const item = await res.json();
		if (!VIDEO_TYPES.has(item?.Type)) return null;
		const minutes = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : 0;
		const seasons = item.Type === 'Series' && item.ChildCount ? `${item.ChildCount} season${item.ChildCount === 1 ? '' : 's'}` : '';
		const imageId = primaryImageId(item);
		return {
			title: item.Name || 'Untitled',
			facts: [ITEM_TYPES[item.Type], item.ProductionYear && String(item.ProductionYear), seasons, formatRuntime(minutes)].filter(Boolean),
			rating: item.CommunityRating ? Math.round(item.CommunityRating * 10) / 10 : null,
			genres: (item.Genres || []).slice(0, 4),
			tagline: item.Taglines?.[0] || '',
			overview: item.Overview || '',
			cast: (item.People || []).filter((p) => p?.Type === 'Actor').map((p) => p.Name).filter(Boolean).slice(0, 8),
			thumbnail: imageId ? `/api/integrations/jellyfin/proxy/image/${encodeURIComponent(imageId)}?maxHeight=${POSTER_HEIGHT}` : undefined,
			backdrop: item.BackdropImageTags?.length ? `/api/integrations/jellyfin/proxy/backdrop/${encodeURIComponent(item.Id)}` : undefined
		};
	},

	proxy: {
		// Backdrop for the detail view, scaled down server-side.
		backdrop: {
			defaultCacheControl: 'private, max-age=86400',
			async fetch({ config, params, fetch }) {
				const id = params.path?.[0];
				if (params.path?.length !== 1 || !id || !ITEM_ID.test(id)) {
					return new Response('Invalid item id', { status: 400 });
				}
				return fetch(`${stripTrailingSlash(config.url)}/Items/${id}/Images/Backdrop?maxWidth=780&quality=85`, {
					method: 'GET',
					headers: { Authorization: authHeaders(config).Authorization }
				});
			}
		},
		// Primary image (poster / cover) for an item, scaled down server-side.
		image: {
			defaultCacheControl: 'private, max-age=86400',
			async fetch({ config, params, request, fetch }) {
				const base = stripTrailingSlash(config.url);
				const id = params.path?.[0];
				if (!id || !ITEM_ID.test(id)) {
					return new Response('Invalid item id', { status: 400 });
				}
				const requested = parseInt(new URL(request.url).searchParams.get('maxHeight') ?? '', 10);
				const maxHeight = Number.isNaN(requested) ? POSTER_HEIGHT : Math.min(Math.max(requested, 32), 600);
				return fetch(`${base}/Items/${id}/Images/Primary?maxHeight=${maxHeight}&quality=90`, {
					method: 'GET',
					headers: { Authorization: authHeaders(config).Authorization }
				});
			}
		}
	},

	widgets: {}
};

function formatRuntime(minutes) {
	if (!minutes) return '';
	const h = Math.floor(minutes / 60);
	return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

// Where links that open in the person's browser point. Holm talks to
// `config.url`, but the browser may reach Jellyfin at a different address: the
// operator's `public_url` wins when it is a plain http(s) URL.
function linkBase(config, publicUrl) {
	if (typeof publicUrl === 'string' && publicUrl.trim()) {
		try {
			const u = new URL(publicUrl.trim());
			if (u.protocol === 'http:' || u.protocol === 'https:') return stripTrailingSlash(u.href);
		} catch {
			// Not a URL: use the server address.
		}
	}
	return stripTrailingSlash(config.url);
}

function stripTrailingSlash(url) {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Jellyfin wants client details on every call, signed in or not.
function authHeaders({ deviceId, accessToken }) {
	const parts = [`Client="Holm"`, `Device="Holm"`, `DeviceId="${quoteSafe(deviceId || 'holm')}"`, `Version="1.0"`];
	if (accessToken) parts.push(`Token="${quoteSafe(accessToken)}"`);
	return { Authorization: `MediaBrowser ${parts.join(', ')}`, accept: 'application/json' };
}

// Tokens are hex and device ids are ours; drop anything that could break out
// of the quoted value.
function quoteSafe(value) {
	return String(value).replace(/[^A-Za-z0-9_-]/g, '');
}

// "Movie · 2019", "Album · Artist · 2020"
function subtitleFor(item) {
	const parts = [ITEM_TYPES[item.Type] || item.Type];
	if (item.Type === 'MusicAlbum' && item.AlbumArtist) parts.push(item.AlbumArtist);
	if (item.ProductionYear) parts.push(String(item.ProductionYear));
	return parts.filter(Boolean).join(' · ');
}

// Lets a Seerr result for the same title stand in for this one.
function tmdbKey(item) {
	const id = item.ProviderIds?.Tmdb;
	const type = item.Type === 'Movie' ? 'movie' : item.Type === 'Series' ? 'tv' : null;
	return id && type && /^\d+$/.test(id) ? `${type}:${id}` : undefined;
}

function primaryImageId(item) {
	return item.ImageTags?.Primary ? item.Id : null;
}

export default adapter;
