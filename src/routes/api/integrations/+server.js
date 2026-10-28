import { json } from '@sveltejs/kit';
import { getSessionUser } from '$lib/server/session.js';
import { getRegistry } from '$lib/server/integrations/index.js';
import { listConnections } from '$lib/server/integrations/store.js';
import { redactConfig, adapterToClient } from '$lib/server/integrations/serialize.js';
import { autoConnect, linkedVia } from '$lib/server/integrations/linked.js';
import { withDeadline } from '$lib/server/integrations/deadline.js';

// GET /api/integrations
// Returns the list of operator-enabled integrations along with each user's
// per-integration connection state. Secret fields are redacted to bullets so
// the API key never leaves the server.

export async function GET({ cookies, url, fetch }) {
	const user = getSessionUser(cookies, url);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Connect integrations that sign in through another one (Seerr through
	// Jellyfin or Plex) before listing, so they show up already connected.
	await autoConnect(user.username, withDeadline(fetch, 5000));

	const registry = getRegistry();
	const connections = user ? await listConnections(user.username) : [];
	const byId = new Map(connections.map((c) => [c.integrationId, c]));

	const integrations = await Promise.all(registry.map(async ({ adapter, icon, operator, availableSurfaces }) => {
		const conn = byId.get(adapter.id);
		return {
			...adapterToClient(adapter, { icon, name: operator?.name, tip: operator?.tip, shortcut: operator?.shortcut }),
			linkedTo: adapter.linkedTo ? await linkedVia(adapter, operator, withDeadline(fetch, 3000)) : null,
			operatorDefaults: pickOperatorDefaults(adapter, operator),
			availableSurfaces,
			userState: {
				connected: !!conn?.connected,
				config: conn?.connected ? redactConfig(adapter, conn.config) : {},
				surfaces: conn?.surfaces || {}
			}
		};
	}));

	return json({ integrations });
}

function pickOperatorDefaults(adapter, operator) {
	const out = {};
	if (!operator) return out;
	for (const field of adapter.configSchema || []) {
		if (field.fromOperatorDefault && operator[field.fromOperatorDefault] != null) {
			out[field.key] = operator[field.fromOperatorDefault];
		}
	}
	// Where the browser reaches the app, when that differs from `default_url`.
	// Only plain http(s) goes to the page, where it becomes a link.
	if (typeof operator.public_url === 'string' && /^https?:\/\//i.test(operator.public_url.trim())) {
		out.publicUrl = operator.public_url.trim();
	}
	return out;
}
