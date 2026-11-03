<script>
	import { browser } from '$app/environment';
	import { portal } from '$lib/actions/portal.js';
	import AppIcon from '$lib/components/AppIcon.svelte';

	// A tile's right-click / long-press menu, placed beside its tile. `health`
	// is the tile's health line (lib/health.js), shown on top: on a phone
	// there's no hover to read it from.
	let { app, anchor, hasGuide = false, health = null, onopen, onguide, onclose } = $props();

	let menuEl = $state(null);
	const host = $derived.by(() => { try { return new URL(app.url).host; } catch { return ''; } });

	// Position relative to the anchor tile after render, flipping to stay
	// inside the viewport.
	$effect(() => {
		if (!menuEl || !app || !anchor) return;
		menuEl.style.left = '0px';
		menuEl.style.top = '0px';

		requestAnimationFrame(() => {
			if (!menuEl || !anchor) return;
			const anchorRect = anchor.getBoundingClientRect();
			const menuRect = menuEl.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const pad = 8;

			// Beside the tile, top edges aligned, so it reads as the tile's menu.
			let x = anchorRect.right + 6;
			let y = anchorRect.top;

			if (x + menuRect.width > vw - pad) x = anchorRect.left - menuRect.width - 6;
			if (x < pad) {
				// No room either side (phones): below the tile, centred on it.
				x = Math.min(Math.max(anchorRect.left + anchorRect.width / 2 - menuRect.width / 2, pad), vw - menuRect.width - pad);
				y = anchorRect.bottom + 6;
				if (y + menuRect.height > vh - pad) y = anchorRect.top - menuRect.height - 6;
			}
			if (y + menuRect.height > vh - pad) y = vh - pad - menuRect.height;
			if (y < pad) y = pad;

			menuEl.style.left = `${x}px`;
			menuEl.style.top = `${y}px`;
			menuEl.style.visibility = 'visible';
		});
	});

	// Dismiss on outside click, or on Escape (focus goes back to the tile).
	$effect(() => {
		if (!browser) return;
		function dismiss(e) {
			if (menuEl && !menuEl.contains(e.target)) onclose();
		}
		function onkey(e) {
			if (e.key !== 'Escape') return;
			onclose();
			anchor?.focus();
		}
		window.addEventListener('click', dismiss);
		window.addEventListener('keydown', onkey);
		return () => {
			window.removeEventListener('click', dismiss);
			window.removeEventListener('keydown', onkey);
		};
	});
</script>

<div
	bind:this={menuEl}
	use:portal
	class="tile-menu fixed z-50 glass-card menu-surface rounded-xl shadow-theme w-[240px] animate-context-in"
	style="visibility: hidden;"
	role="menu"
	aria-label="{app.name} options"
>
	{#if health}
		<div class="tile-menu-health">
			<div class="health-brief-state health-{health.tone}"><i></i><span>{health.state}</span></div>
			<div class="health-brief-title">{health.title}</div>
			{#if health.rest}<div class="health-brief-rest">{health.rest}</div>{/if}
		</div>
	{/if}
	<!-- Which app this menu belongs to -->
	<div class="tile-menu-head">
		<AppIcon icon={app.icon} name={app.name} size="w-[22px] h-[22px]" wrapSize="w-9 h-9" iconStyle="colored" wrap />
		<div class="min-w-0">
			<div class="tile-menu-name">{app.name}</div>
			{#if host}<div class="tile-menu-host">{host}</div>{/if}
		</div>
	</div>
	<div class="py-1.5">
		{#if health?.link}
			<a href={health.link} target="_blank" rel="noopener noreferrer" class="tile-menu-item" role="menuitem" onclick={() => onclose()}>
				<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
				Status page
			</a>
		{/if}
		<a href={app.url} target="_blank" rel="noopener noreferrer" class="tile-menu-item" role="menuitem" onclick={() => { onopen(app); onclose(); }}>
			<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
			Open {app.name}
		</a>
		<button type="button" class="tile-menu-item" role="menuitem" onclick={() => { navigator.clipboard?.writeText(app.url).catch(() => {}); onclose(); }}>
			<svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
			Copy link
		</button>
		<!-- Extra links the operator set on the app (apps[].links) -->
		{#each app.links || [] as link}
			<a href={link.url} target="_blank" rel="noopener noreferrer" class="tile-menu-item" role="menuitem" onclick={() => onclose()}>
				<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
				{link.label}
			</a>
		{/each}
		{#if app.ios || app.android || app.extension || hasGuide}
			<div class="tile-menu-sep"></div>
		{/if}
		{#if app.ios}
			<a href={app.ios} target="_blank" rel="noopener noreferrer" class="tile-menu-item" role="menuitem">
				<svg viewBox="0 0 24 24"><rect width="12" height="20" x="6" y="2" rx="2"/><path d="M11 18h2"/></svg>
				Get the iOS app
			</a>
		{/if}
		{#if app.android}
			<a href={app.android} target="_blank" rel="noopener noreferrer" class="tile-menu-item" role="menuitem">
				<svg viewBox="0 0 24 24"><rect width="12" height="20" x="6" y="2" rx="2"/><path d="M11 18h2"/></svg>
				Get the Android app
			</a>
		{/if}
		{#if app.extension}
			<a href={app.extension} target="_blank" rel="noopener noreferrer" class="tile-menu-item" role="menuitem">
				<svg viewBox="0 0 24 24"><path d="M19.4 13a2.5 2.5 0 0 0 0-5H18V5a1 1 0 0 0-1-1h-3v1.5a2.5 2.5 0 0 1-5 0V4H6a1 1 0 0 0-1 1v3h1.5a2.5 2.5 0 0 1 0 5H5v3a1 1 0 0 0 1 1h3v-1.5a2.5 2.5 0 0 1 5 0V17h3a1 1 0 0 0 1-1v-3Z"/></svg>
				Browser extension
			</a>
		{/if}
		{#if hasGuide}
			<button type="button" class="tile-menu-item" role="menuitem" onclick={() => onguide(app)}>
				<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
				Getting started
			</button>
		{/if}
	</div>
</div>
