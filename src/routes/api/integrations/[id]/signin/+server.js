import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getSessionUser } from '$lib/server/session.js';
import { getAdapter, getOperatorDefaults } from '$lib/server/integrations/index.js';
import { checkUrls } from '$lib/server/integrations/urlPolicy.js';
import { getConnection, upsertConnection } from '$lib/server/integrations/store.js';
import { redactConfig } from '$lib/server/integrations/serialize.js';
import { withDeadline, describeFetchError } from '$lib/server/integrations/deadline.js';
import { autoConnect, adapterContext } from '$lib/server/integrations/linked.js';

// POST /api/integrations/:id/signin
//   { action: 'start', config: { url } }  → { flowId, code } | { status: 'done', ... }
//   { action: 'poll',  flowId }           → { status: 'pending' | 'done' | 'error', ... }
//
// Drives an adapter's `signIn` (e.g. Jellyfin Quick Connect). The adapter's
// state — for Quick Connect, the secret that becomes a token once approved —
// stays in this process and never reaches the browser. When the approval
// lands, the connection is saved here, so the token never does either.

const STEP_TIMEOUT_MS = 8000;
const AUTO_CONNECT_TIMEOUT_MS = 5000;
const FLOW_TTL_MS = 10 * 60 * 1000; // Jellyfin drops an unapproved code after 10 min
const MAX_FLOWS_PER_USER = 3;

/** @type {Map<string, { username: string, adapterId: string, config: object, state: object, expires: number }>} */
const flows = new Map();

function sweep() {
	const now = Date.now();
	for (const [id, f] of flows) if (f.expires < now) flows.delete(id);
}

export async function POST({ cookies, url, request, params, fetch }) {
	const user = getSessionUser(cookies, url);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const adapter = getAdapter(params.id);
	if (!adapter) return json({ error: 'Unknown integration' }, { status: 404 });
	if (!adapter.signIn) return json({ error: 'This integration has no sign-in flow' }, { status: 400 });

	let body;
	try {
		const text = await request.text();
		if (text.length > 4096) return json({ error: 'Payload too large' }, { status: 413 });
		body = JSON.parse(text);
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	sweep();
	const stepFetch = withDeadline(fetch, STEP_TIMEOUT_MS);

	if (body?.action === 'start') {
		const checked = checkUrls(adapter, getOperatorDefaults(adapter.id), visibleConfig(adapter, body.config));
		if (!checked.ok) return json({ error: checked.message }, { status: 400 });
		const config = checked.config;
		for (const field of adapter.configSchema || []) {
			if (field.required && !field.hidden && !config[field.key]) {
				return json({ error: `Missing required field: ${field.label}` }, { status: 400 });
			}
		}
		// A user only ever needs one pending code; cap it so a loop can't
		// fill memory or spam the upstream server with requests.
		const mine = [...flows].filter(([, f]) => f.username === user.username);
		for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_FLOWS_PER_USER + 1))) flows.delete(id);

		// An adapter that signs in through a linked account (Seerr through
		// Jellyfin or Plex) does that first, so reconnecting needs no code.
		// Its own deadline, so a slow attempt leaves the code fallback its full 8 s.
		let linked = {};
		if (adapter.connectFromLinked) {
			({ linked } = await adapterContext(user.username, adapter, null, config));
			if (Object.keys(linked).length) {
				const connected = await adapter
					.connectFromLinked({ config, linked, fetch: withDeadline(fetch, STEP_TIMEOUT_MS) })
					.catch(() => null);
				// The linked account was accepted but Seerr has no user for it:
				// a code would fail the same way.
				if (connected?.error) return json({ error: connected.error }, { status: 502 });
				if (connected) return json(await saveSignIn(user.username, adapter, connected));
			}
		}

		try {
			// A fresh deadline: stepFetch's clock started before the linked attempt.
			const res = await adapter.signIn.start({ config, linked, publicUrl: getOperatorDefaults(adapter.id)?.public_url, fetch: withDeadline(fetch, STEP_TIMEOUT_MS) });
			if (!res || 'error' in res) return json({ error: res?.error || 'Sign-in failed to start' }, { status: 502 });
			const flowId = randomUUID();
			flows.set(flowId, {
				username: user.username,
				adapterId: adapter.id,
				config,
				state: res.state,
				expires: Date.now() + FLOW_TTL_MS
			});
			const link = typeof res.link === 'string' && /^https?:\/\//.test(res.link) ? res.link : null;
			// Instructions that depend on the server (Seerr on Plex or Jellyfin).
			const help = typeof res.help === 'string' ? res.help : null;
			return json({ flowId, code: res.code, link, help, expiresIn: FLOW_TTL_MS / 1000 });
		} catch (err) {
			return json({ error: `Couldn’t reach the server: ${describeFetchError(err, STEP_TIMEOUT_MS)}` }, { status: 502 });
		}
	}

	if (body?.action === 'poll') {
		const flow = typeof body.flowId === 'string' ? flows.get(body.flowId) : null;
		// Someone else's flow id reads exactly like an expired one.
		if (!flow || flow.username !== user.username || flow.adapterId !== adapter.id) {
			return json({ status: 'expired' });
		}
		let res;
		try {
			res = await adapter.signIn.poll({ config: flow.config, state: flow.state, fetch: stepFetch });
		} catch (err) {
			// A blip while waiting isn't fatal; the next poll retries.
			return json({ status: 'pending', warning: describeFetchError(err, STEP_TIMEOUT_MS) });
		}
		if (res?.status === 'pending') return json({ status: 'pending' });
		flows.delete(body.flowId);
		if (res?.status !== 'done') return json({ status: 'error', error: res?.error || 'Sign-in failed' });

		const saved = await saveSignIn(user.username, adapter, { ...flow.config, ...res.config });
		// One sign-in can connect others too (Jellyfin → Seerr), even one the
		// user disconnected before: signing in here asks for it again. Its own
		// deadline: whatever the poll left over may be too little. `forLinked`
		// is what the sign-in can lend them once (Plex's account token), never
		// saved.
		const fresh = res.forLinked ? { [adapter.id]: { ...flow.config, ...res.config, ...res.forLinked } } : {};
		await autoConnect(user.username, withDeadline(fetch, AUTO_CONNECT_TIMEOUT_MS), { fresh, signedIn: adapter.id }).catch(() => {});
		return json(saved);
	}

	return json({ error: 'Unknown action' }, { status: 400 });
}

async function saveSignIn(username, adapter, config) {
	const existing = await getConnection(username, adapter.id);
	const surfaces = existing?.connected ? existing.surfaces : { search: true };
	await upsertConnection(username, adapter.id, { config, surfaces });
	return { status: 'done', userState: { connected: true, config: redactConfig(adapter, config), surfaces } };
}

// Only the user-editable fields come from the browser; hidden ones (tokens,
// ids) are filled by the adapter after approval.
function visibleConfig(adapter, submitted) {
	const out = {};
	for (const field of adapter.configSchema || []) {
		if (field.hidden) continue;
		const v = submitted?.[field.key];
		if (typeof v === 'string' && v.trim()) out[field.key] = v.trim();
	}
	return out;
}
