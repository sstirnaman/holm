// Brand color lookup using simple-icons metadata.
// Builds a slug→hex map at import time (server-side only).

import * as icons from 'simple-icons';

// simple-icons slug → hex, and slug → icon (for serving the SVG without the CDN)
const siSlugToHex = {};
const siBySlug = {};
for (const [key, icon] of Object.entries(icons)) {
	if (key.startsWith('si') && icon?.slug) {
		siSlugToHex[icon.slug] = icon.hex;
		siBySlug[icon.slug] = icon;
	}
}

/** The bundled Simple Icons SVG for a slug, in its brand colour like cdn.simpleicons.org, or null. */
export function simpleIconSvg(slug) {
	const icon = Object.hasOwn(siBySlug, slug) ? siBySlug[slug] : null;
	return icon?.svg ? icon.svg.replace('<svg ', `<svg fill="#${icon.hex}" `) : null;
}

// dashboard-icons slug → simple-icons slug (for names that differ)
const diToSi = {
	'claude-ai': 'claude',
	'google-drive': 'googledrive',
	'google-maps': 'googlemaps',
	'apple-music': 'applemusic',
	'proton-mail': 'protonmail',
	'visual-studio-code': 'visualstudiocode',
};

function contrastColor(hex) {
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.5 ? '#000' : '#fff';
}

/**
 * Resolve brand color for an icon slug.
 * @param {string} iconStr - e.g. "youtube", "claude-ai", "si:youtube" (legacy)
 * @param {string|null} colorOverride - manual hex from config (e.g. "#4F60E5")
 * @returns {{ brandColor: string, brandFg: string } | null}
 */
export function getBrandColor(iconStr, colorOverride) {
	if (colorOverride) {
		const hex = colorOverride.replace('#', '');
		return { brandColor: `#${hex}`, brandFg: contrastColor(hex) };
	}

	if (!iconStr || typeof iconStr !== 'string') return null;
	// Skip full URLs and paths
	if (iconStr.startsWith('http') || iconStr.startsWith('/')) return null;

	// Strip legacy prefix if present
	const diSlug = iconStr.replace(/^(di|si|sh):/, '');
	// Map to simple-icons slug
	const siSlug = diToSi[diSlug] || diSlug;
	const hex = siSlugToHex[siSlug];
	if (!hex) return null;

	const bg = hex.toUpperCase() === 'FFFFFF' ? '#27272a' : `#${hex}`;
	const fg = hex.toUpperCase() === 'FFFFFF' ? '#fff' : contrastColor(hex);

	return { brandColor: bg, brandFg: fg };
}
