// Apps module — builds the flat app catalog and setup guides from config data.
// On the server, config is loaded from YAML. On the client, it's passed via page data.

let warnedOnLegacyShape = false;

// Accept both the new flat shape (apps: [{id, name, ...}]) and the legacy
// nested shape (apps: [{category, items: [...]}]). The legacy shape is
// flattened with a one-time warning so existing operator configs keep loading.
function normalizeAppsInput(appsConfig) {
	if (!Array.isArray(appsConfig)) return [];
	if (appsConfig.length === 0) return [];
	const first = appsConfig[0];
	if (first && Array.isArray(first.items)) {
		if (!warnedOnLegacyShape) {
			warnedOnLegacyShape = true;
			console.warn(
				"[holm] config: nested 'category/items' apps shape is deprecated. " +
					'Flatten apps: into a single list. The category labels are silently ignored.'
			);
		}
		return appsConfig.flatMap((c) => (Array.isArray(c?.items) ? c.items : []));
	}
	return appsConfig;
}

// What a plain click on the tile does (apps[].on_click). Unset is 'open';
// so is an unknown value, or 'getting_started' with nothing to show.
export const CLICK_ACTIONS = ['open', 'getting_started', 'menu'];

function hasGettingStarted(item) {
	return !!(item.setup_guide || item.app_store?.ios || item.app_store?.android);
}

export function clickAction(item) {
	const action = item.on_click ?? 'open';
	if (!CLICK_ACTIONS.includes(action)) return 'open';
	if (action === 'getting_started' && !hasGettingStarted(item)) return 'open';
	return action;
}

// Config problems with on_click, for the startup log.
export function clickActionWarnings(appsConfig) {
	const warnings = [];
	for (const item of normalizeAppsInput(appsConfig)) {
		if (item.on_click === undefined) continue;
		if (!CLICK_ACTIONS.includes(item.on_click)) {
			warnings.push(`apps.${item.id}.on_click ${JSON.stringify(item.on_click)} is not one of ${CLICK_ACTIONS.join(', ')}, so a click opens the app`);
		} else if (item.on_click === 'getting_started' && !hasGettingStarted(item)) {
			warnings.push(`apps.${item.id}.on_click is getting_started but the app has no setup_guide or app_store links, so a click opens the app`);
		}
	}
	return warnings;
}

export function buildAppsFromConfig(appsConfig) {
	const items = normalizeAppsInput(appsConfig);

	const apps = items.map((item) => ({
		id: item.id,
		name: item.name,
		url: item.url,
		icon: resolveIcon(item.icon, item.icon_mono, item.brandColor, item.brandFg, item.brandExplicit),
		selfHosted: item.self_hosted || false,
		default: item.default_visible !== false,
		ios: item.app_store?.ios || null,
		android: item.app_store?.android || null,
		extension: item.browser_extension || null,
		subtitle: item.setup_guide?.subtitle || null,
		tags: Array.isArray(item.tags) ? item.tags : [],
		onClick: clickAction(item)
	}));

	const setupGuides = {};
	for (const item of items) {
		// Store links alone are enough for a Getting started card the app
		// asks for on click; it just has no steps.
		if (item.setup_guide || clickAction(item) === 'getting_started') {
			setupGuides[item.name] = {
				title: `${item.name} setup`,
				subtitle: item.setup_guide?.subtitle || item.name,
				steps: item.setup_guide?.steps || []
			};
		}
	}

	return { apps, setupGuides };
}

// Served through Holm's own cache (routes/api/icon), not the CDNs directly.
const DI_CDN = '/api/icon/di';
const SI_CDN = '/api/icon/si';

// dashboard-icons slug → simpleicons slug (for names that differ)
const diToSimpleIcon = {
	'claude-ai': 'claude',
	'google-drive': 'googledrive',
	'google-maps': 'googlemaps',
	'apple-music': 'applemusic',
	'proton-mail': 'protonmail',
	'visual-studio-code': 'visualstudiocode',
	'paperless-ngx': 'paperlessngx',
	'uptime-kuma': 'uptimekuma',
};

// Resolve a single icon string to a URL
function resolveUrl(str) {
	if (!str) return null;
	if (str.startsWith('http') || str.startsWith('/')) return str;
	// Names typed with spaces or capitals still resolve: "Hacker News" becomes
	// hacker-news (Dashboard Icons are kebab-case) and "Stack Overflow" becomes
	// stackoverflow (Simple Icons slugs are bare a-z0-9).
	const name = str.replace(/^(di|si|sh):/, '').trim().toLowerCase();
	const prefix = str.match(/^(di|si|sh):/)?.[1] || 'di';
	if (prefix === 'si') return `${SI_CDN}/${diToSimpleIcon[name] || name.replace(/[^a-z0-9]/g, '')}`;
	return `${DI_CDN}/${name.replace(/\s+/g, '-')}.svg`;
}

export function resolveIcon(icon, iconMono, brandColor, brandFg, brandExplicit) {
	if (!icon) return { colored: null, mono: null, hasMono: false, brandColor: null, brandFg: null, brandExplicit: false };

	// Object format: { colored: "url", mono: "url" }
	if (typeof icon === 'object') {
		return { colored: icon.colored || null, mono: icon.mono || icon.colored || null, hasMono: !!icon.mono, fallback: null, brandColor: brandColor || null, brandFg: brandFg || null, brandExplicit: !!brandExplicit };
	}

	// Full URL or absolute path
	if (icon.startsWith('http') || icon.startsWith('/')) {
		const mono = iconMono ? resolveUrl(iconMono) : null;
		return { colored: icon, mono: mono || icon, hasMono: !!iconMono, fallback: null, brandColor: brandColor || null, brandFg: brandFg || null, brandExplicit: !!brandExplicit };
	}

	const name = icon.replace(/^(di|si|sh):/, '');
	const colored = resolveUrl(icon);

	// Mono: explicit icon_mono > Simple Icons fallback
	let mono, hasMono;
	if (iconMono) {
		mono = resolveUrl(iconMono);
		hasMono = true;
	} else {
		const siSlug = diToSimpleIcon[name] || name;
		mono = `${SI_CDN}/${siSlug}`;
		hasMono = true; // SI may or may not have it — handleIconError covers failures
	}

	return {
		colored,
		mono,
		hasMono,
		fallback: colored,
		brandColor: brandColor || null,
		brandFg: brandFg || null,
		brandExplicit: !!brandExplicit
	};
}
