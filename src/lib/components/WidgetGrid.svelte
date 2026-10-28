<script>
	import { onMount, untrack, getContext } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { browser } from '$app/environment';
	import { prefs } from '$lib/stores/prefs.js';
	import { buildAppsFromConfig, resolveIcon } from '$lib/apps.js';
	import AppIcon from '$lib/components/AppIcon.svelte';
	import { getBrandBgStyle } from '$lib/iconHelpers.js';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import TileContextMenu from '$lib/components/TileContextMenu.svelte';
	import SetupGuideModal from '$lib/components/SetupGuideModal.svelte';
	import AddAppPicker from '$lib/components/AddAppPicker.svelte';
	import { registry, getRegistryEntry, WIDGET_TYPES } from '$lib/widgets/registry.js';
	import {
		defaultWidgetLayout,
		synthesizeFromLegacyPrefs,
		updateLayoutPositions,
		removeInstance,
		addAppInstance,
		findAppInstance,
		clamp
	} from '$lib/widgets/layout.js';
	import { POPULAR_APPS } from '$lib/popularApps.js';
	import { recordOpen } from '$lib/launcher/frecency.js';
	import { healthLine, healthLabel } from '$lib/health.js';
	import { portal } from '$lib/actions/portal.js';

	let {
		guideApp = $bindable(null),
		editMode = $bindable(false),
		searchEnabled = false,
		customizationEnabled = false,
		onSettingsOpen = () => {}
	} = $props();

	const siteConfig = getContext('config');

	// Setup guides keyed by app name, for the tile context menu's "Getting
	// started" entry and the modal it opens. Same helper +page.svelte uses for
	// tipApps. clickActions: what a plain click does, by app id.
	const builtApps = $derived.by(() => buildAppsFromConfig(siteConfig?.apps));
	const setupGuides = $derived(builtApps.setupGuides);
	const clickActions = $derived(Object.fromEntries(builtApps.apps.map((a) => [a.id, a.onClick])));

	// Flat catalog: config apps (already filtered by group on the server) +
	// per-user custom bookmarks. One source of truth used by every
	// callsite below — no widget reaches back into config or stores.
	const configApps = $derived.by(() => {
		const list = [];
		const raw = siteConfig?.apps;
		if (!Array.isArray(raw)) return list;
		// Server normalizes to flat, but tolerate the legacy nested shape too.
		const isLegacy = raw.length > 0 && Array.isArray(raw[0]?.items);
		const items = isLegacy ? raw.flatMap((c) => c.items || []) : raw;
		for (const item of items) {
			list.push({
				id: item.id,
				name: item.name,
				url: item.url,
				icon: resolveIcon(
					item.icon,
					item.icon_mono,
					item.brandColor,
					item.brandFg,
					item.brandExplicit
				),
				selfHosted: item.self_hosted || false,
				default: item.default_visible !== false,
				ios: item.app_store?.ios || null,
				android: item.app_store?.android || null,
				extension: item.browser_extension || null,
				subtitle: item.setup_guide?.subtitle || null,
				tags: Array.isArray(item.tags) ? item.tags : []
			});
		}
		return list;
	});


	// A saved bookmark keeps the icon it was added with. Popular ones take the
	// current icon from the list instead, so a corrected slug also fixes tiles
	// that were added before the fix.
	const popularIcons = new Map(POPULAR_APPS.map((p) => [p.id, p.icon]));

	const customCatalog = $derived.by(() => {
		const list = $prefs.customApps || [];
		return list.map((a) => ({
			id: a.id,
			name: a.name,
			url: a.url,
			icon: resolveIcon(popularIcons.get(a.id) ?? a.icon),
			selfHosted: false,
			default: true,
			ios: null,
			android: null,
			extension: null,
			subtitle: null,
			tags: ['bookmark']
		}));
	});

	const catalog = $derived.by(() => {
		const out = [];
		const seen = new Set();
		for (const a of configApps) {
			if (!seen.has(a.id)) {
				seen.add(a.id);
				out.push(a);
			}
		}
		for (const a of customCatalog) {
			if (!seen.has(a.id)) {
				seen.add(a.id);
				out.push(a);
			}
		}
		return out;
	});

	const widgetLayout = $derived(Array.isArray($prefs.widgetLayout) ? $prefs.widgetLayout : null);

	// Lazy migration: synthesize from legacy prefs on first mount when the user
	// has no widgetLayout. Strips obsolete keys so they don't get re-synced.
	let migrated = $state(false);
	$effect(() => {
		if (!browser || migrated) return;
		if (Array.isArray($prefs.widgetLayout)) {
			migrated = true;
			return;
		}
		// Wait until the catalog is populated to avoid migrating against an
		// empty list (which would skip everything).
		if (catalog.length === 0) return;
		untrack(() => {
			const hasLegacy =
				Array.isArray($prefs.categoryLayout) ||
				$prefs.gridLayouts ||
				Array.isArray($prefs.visibleApps) ||
				($prefs.dashboardView && typeof $prefs.dashboardView === 'string');
			const synthesized = hasLegacy
				? synthesizeFromLegacyPrefs($prefs, catalog, registry)
				: defaultWidgetLayout(catalog, registry);
			prefs.update((p) => {
				const next = { ...p, widgetLayout: synthesized };
				delete next.categoryLayout;
				delete next.gridLayouts;
				delete next.dashboardView;
				return next;
			});
			migrated = true;
		});
	});

	// Resolve each widget instance to its app for rendering. Skip instances
	// whose appId is no longer in catalog (e.g. an admin removed the app).
	const renderInstances = $derived.by(() => {
		if (!Array.isArray(widgetLayout)) return [];
		const byId = new Map(catalog.map((a) => [a.id, a]));
		const out = [];
		for (const inst of widgetLayout) {
			const entry = getRegistryEntry(inst.type);
			if (!entry) continue;
			if (inst.type === WIDGET_TYPES.APP) {
				const app = byId.get(inst.config?.appId);
				if (!app) continue;
				out.push({ inst: clamp(inst, entry), app });
			}
		}
		return out;
	});

	const placedAppIds = $derived.by(() => {
		const ids = new Set();
		if (Array.isArray(widgetLayout)) {
			for (const inst of widgetLayout) {
				if (inst.type === WIDGET_TYPES.APP && inst.config?.appId) {
					ids.add(inst.config.appId);
				}
			}
		}
		return ids;
	});

	// Tray apps in edit mode: catalog apps not currently on the surface.
	const trayApps = $derived(catalog.filter((a) => !placedAppIds.has(a.id)));

	// Popular suggestions: curated bookmarks the user hasn't already added or
	// placed. Hidden once the operator has filled the surface or matched any
	// popular slug into their own customApps.
	const popularSuggestions = $derived.by(() => {
		// Catalog apps count too, so an app the operator already ships (GitHub,
		// say) isn't offered twice under "Your apps" and "Popular".
		const known = [...catalog, ...($prefs.customApps || [])];
		const ids = new Set(known.map((a) => a.id));
		const urls = new Set(known.map((a) => a.url));
		const names = new Set(known.map((a) => a.name?.toLowerCase()));
		return POPULAR_APPS.filter(
			(p) => !placedAppIds.has(p.id) && !ids.has(p.id) && !urls.has(p.url) && !names.has(p.name.toLowerCase())
		);
	});

	const iconStyle = $derived($prefs.iconStyle || 'colored');
	const openInNewTab = $derived($prefs.openInNewTab ?? true);

	// Recently-opened apps tracking (lifted unchanged from AppGrid).
	function recordAppOpen(appId) {
		recordOpen(`app:${appId}`);
		prefs.update((p) => {
			const prev = Array.isArray(p.recentApps) ? p.recentApps : [];
			const next = [appId, ...prev.filter((id) => id !== appId)].slice(0, 16);
			return { ...p, recentApps: next };
		});
	}

	function placeAppOnSurface(appId) {
		prefs.update((p) => {
			const layout = Array.isArray(p.widgetLayout) ? p.widgetLayout : [];
			if (findAppInstance(layout, appId)) return p; // already placed
			return { ...p, widgetLayout: addAppInstance(layout, appId, registry) };
		});
	}

	function placePopularOnSurface(popular) {
		// Adds the popular as a customApp (if not already present) and places it
		// on the surface in a single prefs update so renderInstances and the
		// catalog stay in sync within one render pass.
		prefs.update((p) => {
			const customApps = Array.isArray(p.customApps) ? p.customApps : [];
			const layout = Array.isArray(p.widgetLayout) ? p.widgetLayout : [];
			const nextCustom = customApps.some((a) => a.id === popular.id)
				? customApps
				: [...customApps, { id: popular.id, name: popular.name, url: popular.url, icon: popular.icon }];
			const nextLayout = findAppInstance(layout, popular.id)
				? layout
				: addAppInstance(layout, popular.id, registry);
			return { ...p, customApps: nextCustom, widgetLayout: nextLayout };
		});
	}

	function removeFromSurface(instanceId) {
		prefs.update((p) => {
			const layout = Array.isArray(p.widgetLayout) ? p.widgetLayout : [];
			return { ...p, widgetLayout: removeInstance(layout, instanceId) };
		});
	}

	// Reset swaps to Undo for a few seconds rather than asking first.
	let surfaceUndo = $state(null);
	let surfaceUndoTimer;

	function resetSurface() {
		surfaceUndo = { widgetLayout: $prefs.widgetLayout };
		clearTimeout(surfaceUndoTimer);
		surfaceUndoTimer = setTimeout(() => (surfaceUndo = null), 8000);
		prefs.update((p) => ({
			...p,
			widgetLayout: defaultWidgetLayout(catalog, registry)
		}));
	}

	function undoResetSurface() {
		const snapshot = surfaceUndo;
		surfaceUndo = null;
		clearTimeout(surfaceUndoTimer);
		if (snapshot) prefs.update((p) => ({ ...p, widgetLayout: snapshot.widgetLayout }));
	}

	// ── App health: the server checks, this only asks for the last answers ──
	const HEALTH_POLL = 30_000;
	let health = $state({});
	let healthNow = $state(Date.now());
	let healthTip = $state(null);

	async function loadHealth() {
		try {
			const res = await fetch('/api/health');
			if (res.ok) health = (await res.json()).apps || {};
		} catch { /* keep the last answers */ }
		healthNow = Date.now();
	}

	// Configure → Widgets → App status turns the dots off for this person.
	const healthOn = $derived(siteConfig?.health?.enabled && $prefs.healthDots !== false);

	$effect(() => {
		if (!healthOn) health = {};
		if (!browser || !configApps.length || !healthOn) return;
		loadHealth();
		// Right after a restart the server may not have answers yet.
		const soon = setTimeout(loadHealth, 5000);
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') loadHealth();
		}, HEALTH_POLL);
		const onVisible = () => document.visibilityState === 'visible' && loadHealth();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearTimeout(soon);
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	let healthTipTimer = null;
	function showHealthTip(app, e) {
		clearTimeout(healthTipTimer);
		const line = healthLine(app, health[app.id], healthNow);
		if (!line || editMode) return;
		// Under the tile, so it never covers the name; as wide as the line
		// needs, up to the window's edge, moving left when that's too close.
		const r = e.currentTarget.getBoundingClientRect();
		const vw = window.innerWidth;
		const x = vw - 8 - r.left < 360 ? Math.max(8, vw - 8 - 360) : r.left;
		healthTip = { line, x, y: r.bottom + 6, max: vw - 8 - x };
	}
	// A moment's grace, so the pointer can reach a tip that links somewhere.
	function hideHealthTip() {
		clearTimeout(healthTipTimer);
		healthTipTimer = setTimeout(() => (healthTip = null), healthTip?.line.link ? 250 : 0);
	}

	// ── Tile context menu (right-click / long-press) — ported from AppGrid ──
	let contextApp = $state(null);
	let contextAnchor = $state(null);
	let longPressTimer = null;
	// Set when a long-press opened the menu, so the click that follows the
	// finger lifting doesn't also open the app.
	let longPressFired = false;

	function showContext(app, e) {
		e.preventDefault();
		e.stopPropagation();
		contextAnchor = e.currentTarget;
		contextApp = app;
	}

	function startLongPress(app, e) {
		const target = e.currentTarget;
		longPressFired = false;
		longPressTimer = setTimeout(() => {
			longPressFired = true;
			contextAnchor = target;
			contextApp = app;
		}, 500);
	}

	function endLongPress(e) {
		if (longPressFired) {
			e.preventDefault();
			// preventDefault usually suppresses the click, which would otherwise
			// be what clears the flag; don't let it eat the next real click.
			setTimeout(() => (longPressFired = false), 400);
		}
		cancelLongPress();
	}

	function cancelLongPress() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
	}

	function openGuide(app) {
		contextApp = null;
		guideApp = app;
	}

	// Apps whose Getting started card opens on a plain click
	// (on_click: getting_started), until this user opts out from the card.
	function guideClickable(app) {
		return clickActions[app.id] === 'getting_started' && !!setupGuides[app.name];
	}
	function guideOnClick(app) {
		return guideClickable(app) && !($prefs.guidesDismissed || []).includes(app.id);
	}

	function dismissGuide(app, dismissed) {
		const rest = ($prefs.guidesDismissed || []).filter((id) => id !== app.id);
		prefs.update((p) => ({ ...p, guidesDismissed: dismissed ? [...rest, app.id] : rest }));
	}

	function closeGuide() {
		guideApp = null;
	}

	let searchInput = $state('');
	let pickerOpen = $state(false);
	let addBtnEl = $state(null);
	// ── GridStack ──
	let gridEl = $state(null);
	let grid = null;

	// Track the active breakpoint's column count so we can horizontally center
	// the row of tiles when it's narrower than the grid. Mirrors the same
	// thresholds passed to GridStack's columnOpts.breakpoints below.
	let cols = $state(12);
	function syncCols() {
		if (typeof window === 'undefined') return;
		const w = window.innerWidth;
		cols = w < 480 ? 4 : w < 768 ? 6 : w < 1024 ? 8 : 12;
	}

	const tileCount = $derived(renderInstances.length + (editMode ? 1 : 0));

	// Visual shift to center the single-row layout. Zero once the row would
	// wrap (multi-row centering looks lopsided). Applied as a translateX on
	// the grid container — keeps GridStack's internal coords untouched and
	// avoids fighting compact() / cell sizing.
	const centerShiftPct = $derived.by(() => {
		if (tileCount === 0 || tileCount >= cols) return 0;
		return ((cols - tileCount) / 2 / cols) * 100;
	});
	// Tracks which instances GridStack has registered. Svelte owns the DOM
	// inside .grid-stack via the {#each} block, but GridStack only learns about
	// new children when we explicitly call makeWidget on them. The reverse is
	// true on removal — we must unregister BEFORE Svelte detaches the node.
	const managedEls = new Map(); // instanceId → HTMLElement

	// Park the __add__ tile at the bottom of the grid so the next compact()
	// flows it back to the end. Called before every add/remove/drag reflow —
	// otherwise GridStack's internal state keeps __add__ wherever the last
	// compact left it, which causes collisions to push new tiles past it.
	// We mutate the internal node in addition to grid.update because float:false
	// can snap __add__ up to the first free row before compact runs, leaving
	// it at y=1 instead of y=999 and breaking the "always last" sort.
	function reparkAddTile() {
		if (!grid) return;
		const addEl = managedEls.get('__add__');
		if (!addEl) return;
		try { grid.update(addEl, { x: 0, y: 999 }); } catch {}
		if (addEl.gridstackNode) {
			addEl.gridstackNode.x = 0;
			addEl.gridstackNode.y = 999;
		}
	}

	function saveLayoutFromGrid() {
		if (!grid) return;
		const positions = [];
		for (const el of grid.getGridItems()) {
			const id = el.getAttribute('gs-id');
			const node = el.gridstackNode;
			if (!id || id === '__add__' || !node) continue;
			positions.push({ instanceId: id, x: node.x, y: node.y, w: node.w, h: node.h });
		}
		prefs.update((p) => {
			const layout = Array.isArray(p.widgetLayout) ? p.widgetLayout : [];
			return { ...p, widgetLayout: updateLayoutPositions(layout, positions) };
		});
	}

	async function initGrid(isCancelled) {
		if (!gridEl || grid) return;
		const { GridStack } = await import('gridstack');
		if (isCancelled?.() || !gridEl?.isConnected) return;

		grid = GridStack.init(
			{
				column: 12,
				// Cell height = icon (44) + vertical padding (~13) + gap (~5)
				// + name line (~14) + breathing room. 92 fits cleanly.
				cellHeight: 92,
				float: false,
				animate: !prefersReducedMotion.current,
				handle: '.gs-drag-handle',
				disableResize: true,
				disableDrag: true,
				margin: 6,
				columnOpts: {
					breakpointForWindow: true,
					// `list` flows tiles in their existing order at the new column
					// count instead of clamping x to fit (which collapses high-x
					// tiles into the rightmost column on mobile).
					layout: 'list',
					breakpoints: [
						{ w: 480, c: 4, layout: 'list' },
						{ w: 768, c: 6, layout: 'list' },
						{ w: 1024, c: 8, layout: 'list' },
						{ w: 1280, c: 12, layout: 'list' }
					]
				}
			},
			gridEl
		);

		grid.on('dragstop', () => {
			// Re-park __add__ to y=999, then compact so it lands after the
			// dragged tile's new position. Without this, GridStack's collision
			// resolution can leave + sitting between apps.
			reparkAddTile();
			grid.compact('list');
			saveLayoutFromGrid();
		});
		grid.on('resizestop', () => saveLayoutFromGrid());

		// Seed the managed-elements map with whatever GridStack picked up
		// during init. Subsequent additions/removals go through syncGrid().
		for (const el of grid.getGridItems()) {
			const id = el.getAttribute('gs-id');
			if (id) managedEls.set(id, el);
		}

		// Initial reflow: when the breakpoint is narrower than the layout was
		// originally authored at (e.g. 12-col positions on a 4-col mobile),
		// GridStack falls back to clamping x values, which collapses high-x
		// tiles into the rightmost column. compact() reflows them sequentially
		// into the available columns, preserving order. Safe to call on every
		// init — it's a no-op when the layout already fits.
		requestAnimationFrame(() => {
			if (!grid) return;
			grid.compact('list');
		});
	}

	// Reconcile Svelte-rendered tiles with GridStack's internal node list.
	// Called from a $effect that depends on renderInstances + editMode; diffs
	// the expected set against managedEls and adds/removes as needed. The
	// special `__add__` tile is treated as expected only when editMode is on.
	function syncGrid(instances, isEditing) {
		if (!grid || !gridEl) return;
		const expected = new Set(instances.map((entry) => entry.inst.instanceId));
		if (isEditing) expected.add('__add__');

		// Remove first so freed cells become available before placing new tiles.
		let didRemove = false;
		for (const [id, el] of managedEls) {
			if (expected.has(id)) continue;
			try { grid.removeWidget(el, false, false); } catch {}
			managedEls.delete(id);
			didRemove = true;
		}

		// Re-park __add__ before placing new tiles so the slot where + currently
		// sits is freed up — otherwise a new app spawning at findFreeSlot's
		// {x,y} can collide with __add__ and get bumped to a fresh row.
		reparkAddTile();

		// Register newly-rendered app tiles.
		for (const { inst } of instances) {
			if (managedEls.has(inst.instanceId)) continue;
			const el = gridEl.querySelector(`[gs-id="${inst.instanceId}"]`);
			if (el) {
				grid.makeWidget(el);
				managedEls.set(inst.instanceId, el);
			}
		}

		// Register the add-tile when entering edit mode.
		if (isEditing && !managedEls.has('__add__')) {
			const el = gridEl.querySelector('[gs-id="__add__"]');
			if (el) {
				grid.makeWidget(el);
				managedEls.set('__add__', el);
			}
		}

		// Always compact — packs tiles left-to-right, top-to-bottom (so removed
		// cells close in-row) AND snaps the __add__ tile (re-parked above at
		// y=999) up to the next free cell after the last app. Save positions
		// afterward when something app-side actually changed.
		requestAnimationFrame(() => {
			if (!grid) return;
			grid.compact('list');
			if (didRemove) saveLayoutFromGrid();
		});
	}

	// Sync edit-mode → GridStack drag gating. Resize stays disabled — iOS-style
	// edit mode is "drag to rearrange, × to remove," nothing else.
	let prevEditMode = false;
	$effect(() => {
		const current = editMode;
		untrack(() => {
			if (current === prevEditMode) return;
			prevEditMode = current;
			if (!grid) return;
			grid.enableMove(current);
		});
	});

	// Esc exits edit mode. Skipped when the user is typing in an input —
	// SearchBar owns its own Esc handler and we don't want to steal it.
	$effect(() => {
		if (!browser || !editMode) return;
		function onKey(e) {
			if (e.key !== 'Escape') return;
			const t = e.target;
			const tag = t?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
			e.preventDefault();
			pickerOpen = false;
			editMode = false;
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// Reconcile DOM additions/removals with GridStack's node list. Runs after
	// Svelte's {#each} re-renders or after editMode toggles, which is exactly
	// when new tiles (or the special __add__ tile) need to be registered or
	// unregistered.
	$effect(() => {
		const instances = renderInstances;
		const isEditing = editMode;
		untrack(() => syncGrid(instances, isEditing));
	});

	onMount(() => {
		let cancelled = false;
		syncCols();
		const onResize = () => syncCols();
		window.addEventListener('resize', onResize);
		requestAnimationFrame(() => {
			if (!cancelled) initGrid(() => cancelled);
		});
		return () => {
			cancelled = true;
			window.removeEventListener('resize', onResize);
			if (grid) {
				grid.destroy(false);
				grid = null;
			}
		};
	});
</script>

<!-- Hero area: search bar. Always visible regardless of edit mode —
     entering edit only adds a `+` tile to the surface below, it does not
     take over the search slot. -->
<div class="hero-area">
	{#if searchEnabled}
		<div class="hero-slot">
			<SearchBar bind:query={searchInput} apps={catalog} {onSettingsOpen} />
		</div>
	{/if}
</div>

{#if customizationEnabled && editMode}
	<div class="surface-header is-editing">
		<span class="surface-label"
			>{renderInstances.length}
			{renderInstances.length === 1 ? 'app' : 'apps'}</span
		>
		<div class="surface-actions">
			{#if surfaceUndo}
				<button
					type="button"
					class="tray-reset tray-undo"
					onclick={undoResetSurface}
					aria-label="Undo layout reset"
				>Undo</button>
			{:else}
				<button
					type="button"
					class="tray-reset"
					onclick={resetSurface}
					title="Reset surface to default layout"
					aria-label="Reset surface to default layout"
				>Reset</button>
			{/if}
			<button
				type="button"
				class="tray-done"
				onclick={() => (editMode = false)}
			>Done</button>
		</div>
	</div>
{/if}

<div class="grid-center-wrap" style="transform: translateX({centerShiftPct}%);">
<div
	bind:this={gridEl}
	class="grid-stack widget-surface {editMode ? 'grid-edit-mode' : ''}"
>
	{#each renderInstances as { inst, app } (inst.instanceId)}
		{@const entry = getRegistryEntry(inst.type)}
		<div
			class="grid-stack-item"
			gs-id={inst.instanceId}
			gs-x={inst.x}
			gs-y={inst.y}
			gs-w={inst.w}
			gs-h={inst.h}
			gs-min-w={entry?.minSize?.w ?? 1}
			gs-min-h={entry?.minSize?.h ?? 1}
			gs-max-w={entry?.maxSize?.w ?? 12}
			gs-max-h={entry?.maxSize?.h ?? 12}
		>
			<div class="grid-stack-item-content">
				<div class="app-tile gs-drag-handle">
					<a
						href={editMode ? null : app.url}
						target={openInNewTab ? '_blank' : undefined}
						rel={openInNewTab ? 'noopener noreferrer' : undefined}
						class="app-tile-link"
						class:menu-open={contextApp?.id === app.id}
						class:health-faded={health[app.id]?.state === 'down'}
						title={healthLine(app, health[app.id]) ? undefined : app.name}
						aria-label={healthLabel(app, health[app.id])}
						onmouseenter={(e) => showHealthTip(app, e)}
						onmouseleave={hideHealthTip}
						onclick={(e) => {
							if (editMode || longPressFired) {
								e.preventDefault();
								longPressFired = false;
								return;
							}
							// Ctrl/⌘-click still opens a new tab.
							if (!e.metaKey && !e.ctrlKey && guideOnClick(app)) {
								e.preventDefault();
								guideApp = app;
								return;
							}
							if (!e.metaKey && !e.ctrlKey && clickActions[app.id] === 'menu') {
								showContext(app, e);
								return;
							}
							recordAppOpen(app.id);
						}}
						oncontextmenu={editMode ? undefined : (e) => showContext(app, e)}
						ontouchstart={editMode ? undefined : (e) => startLongPress(app, e)}
						ontouchend={editMode ? undefined : endLongPress}
						ontouchmove={editMode ? undefined : cancelLongPress}
					>
						<span class="app-tile-icon-slot">
							<div
								class="app-tile-icon"
								style={iconStyle === 'colored' ? getBrandBgStyle(app.icon) : ''}
							>
								<AppIcon icon={app.icon} name={app.name} size="w-7 h-7" {iconStyle} />
							</div>
							{#if healthLine(app, health[app.id])}
								<span class="health-dot health-{healthLine(app, health[app.id]).tone}" aria-hidden="true"></span>
							{/if}
						</span>
						<span class="app-tile-name">{app.name}</span>
					</a>
					{#if editMode}
						<button
							type="button"
							class="app-tile-remove"
							aria-label="Remove {app.name} from surface"
							title="Remove from surface"
							onclick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								removeFromSurface(inst.instanceId);
							}}
							onpointerdown={(e) => e.stopPropagation()}
						>×</button>
					{/if}
				</div>
			</div>
		</div>
	{/each}
	{#if editMode}
		<!-- Add-app tile. Mirrors the .app-tile structure exactly so the + slot
		     aligns with the surrounding tiles (same icon footprint + name row).
		     Parked at gs-y=999 and reflowed to the last free cell by compact()
		     after every add/remove/drag. We deliberately don't set gs-no-move
		     so collisions push it aside; user-drag is gated by the absence of
		     .gs-drag-handle on this tile (see grid handle config). -->
		<div
			class="grid-stack-item add-tile-wrap"
			gs-id="__add__"
			gs-x="0"
			gs-y="999"
			gs-w="1"
			gs-h="1"
			gs-no-resize="true"
		>
			<div class="grid-stack-item-content">
				<div class="app-tile add-tile">
					<button
						type="button"
						class="app-tile-link add-btn"
						aria-label="Add app"
						aria-expanded={pickerOpen}
						bind:this={addBtnEl}
						onclick={() => (pickerOpen = !pickerOpen)}
					>
						<div class="app-tile-icon add-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-7 h-7">
								<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
							</svg>
						</div>
						<span class="app-tile-name">Add</span>
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
</div>

<!-- Tile context menu (portal to body to escape transform containing block) -->
{#if contextApp}
	<TileContextMenu
		app={contextApp}
		anchor={contextAnchor}
		hasGuide={!!setupGuides[contextApp.name]}
		health={healthLine(contextApp, health[contextApp.id], healthNow)}
		onopen={(app) => recordAppOpen(app.id)}
		onguide={openGuide}
		onclose={() => (contextApp = null)}
	/>
{/if}

{#snippet healthTipBody(line)}
	<div class="health-brief-state health-{line.tone}">
		<i></i><span>{line.state}</span>
		{#if line.link}<span class="health-tip-check">Check →</span>{/if}
	</div>
	<div class="health-brief-title">{line.title}</div>
	{#if line.rest}<div class="health-brief-rest">{line.rest}</div>{/if}
{/snippet}
{#if healthTip && !contextApp}
	{#if healthTip.line.link}
		<a
			use:portal
			class="health-tip linked glass-card menu-surface"
			href={healthTip.line.link}
			target="_blank"
			rel="noopener noreferrer"
			style="left: {healthTip.x}px; top: {healthTip.y}px; max-width: {healthTip.max}px;"
			onmouseenter={() => clearTimeout(healthTipTimer)}
			onmouseleave={hideHealthTip}
			onclick={() => (healthTip = null)}
		>{@render healthTipBody(healthTip.line)}</a>
	{:else}
		<div use:portal class="health-tip glass-card menu-surface" role="tooltip" style="left: {healthTip.x}px; top: {healthTip.y}px; max-width: {healthTip.max}px;">
			{@render healthTipBody(healthTip.line)}
		</div>
	{/if}
{/if}

<!-- Setup Guide Modal (portal to body) -->
{#if guideApp && setupGuides[guideApp.name]}
	<SetupGuideModal
		app={guideApp}
		guide={setupGuides[guideApp.name]}
		{iconStyle}
		dismissible={guideClickable(guideApp)}
		{openInNewTab}
		dismissed={($prefs.guidesDismissed || []).includes(guideApp.id)}
		ondismiss={(d) => dismissGuide(guideApp, d)}
		onopenapp={() => recordAppOpen(guideApp.id)}
		onclose={closeGuide}
	/>
{/if}

{#if customizationEnabled}
	{#if editMode}
		<div class="edit-hint" role="status">
			Click + to add an app · drag tiles to rearrange
		</div>
	{:else}
		<div class="surface-footer">
			<button
				type="button"
				class="edit-chip"
				onclick={() => (editMode = true)}
				aria-label="Edit layout"
				title="Edit layout"
			>Edit</button>
		</div>
	{/if}
{/if}

{#if editMode && pickerOpen}
	<AddAppPicker
		anchor={addBtnEl}
		{trayApps}
		{popularSuggestions}
		{iconStyle}
		onplace={(app) => { placeAppOnSurface(app.id); pickerOpen = false; }}
		onplacepopular={(app) => { placePopularOnSurface(app); pickerOpen = false; }}
		onclose={() => (pickerOpen = false)}
	/>
{/if}

<style>
	.hero-area {
		padding: 1rem 0 1.5rem;
	}
	/* Hint line shown only in edit mode, parked under the surface (after the
	   grid + Reset/Done row). Mirrors the chip typography (size, tracking,
	   muted tone) so the edit surface reads as one tonal family. */
	.edit-hint {
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		color: var(--color-content-dim, #a1a1aa);
		opacity: 0.7;
		text-align: center;
		margin-top: 1rem;
		margin-bottom: 1rem;
	}
	/* Reset and Done share the Edit chip shape so the surface controls read
	   as one family. Done gets a slightly brighter border to mark it as the
	   primary action without breaking out into a colored CTA. */
	.tray-reset,
	.tray-done {
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		padding: 0.2rem 0.6rem;
		border-radius: 9999px;
		background: transparent;
		border: 1px solid rgba(255, 255, 255, 0.10);
		color: var(--color-content-dim, #a1a1aa);
		opacity: 0.7;
		cursor: pointer;
		transition: background 180ms var(--ease-standard, ease),
			border-color 180ms, color 180ms, opacity 180ms;
	}
	.tray-undo {
		color: var(--color-content, #fafafa);
		opacity: 1;
	}
	.tray-done {
		border-color: rgba(255, 255, 255, 0.22);
		color: var(--color-content-muted, #d4d4d8);
		opacity: 0.9;
	}
	.tray-reset:hover,
	.tray-reset:focus-visible,
	.tray-done:hover,
	.tray-done:focus-visible {
		background: rgba(255, 255, 255, 0.06);
		border-color: rgba(255, 255, 255, 0.32);
		color: var(--color-content, #fafafa);
		opacity: 1;
		outline: none;
	}
	/* The pill borders and hovers above are white-alpha, invisible on the
	   light theme; mirror them in black-alpha there. */
	:global(.theme-light) .tray-reset,
	:global(.theme-light) .tray-done,
	:global(.theme-light) .edit-chip {
		border-color: rgba(0, 0, 0, 0.14);
	}
	:global(.theme-light) .tray-reset:hover,
	:global(.theme-light) .tray-reset:focus-visible,
	:global(.theme-light) .tray-done:hover,
	:global(.theme-light) .tray-done:focus-visible,
	:global(.theme-light) .edit-chip:hover,
	:global(.theme-light) .edit-chip:focus-visible {
		background: rgba(0, 0, 0, 0.05);
		border-color: rgba(0, 0, 0, 0.3);
	}
	.hero-slot {
		min-height: 3rem;
	}
	/* Edit-mode add tile — same structural layout as .app-tile so the icon
	   and name row line up with the surrounding tiles pixel-for-pixel. The
	   icon square is borrowed via .app-tile-icon, then overridden to dashed
	   "empty slot" styling. */
	.add-btn {
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
	}
	.add-btn.app-tile-link:hover {
		background: transparent;
		border-color: transparent;
	}
	.add-icon {
		background: transparent;
		border: 1px dashed var(--text-dim);
		color: var(--text-muted);
		box-shadow: none !important;
		transition: border-color 200ms, color 200ms;
	}
	.add-btn:hover .add-icon,
	.add-btn[aria-expanded='true'] .add-icon {
		border-style: solid;
		color: var(--text);
	}

	.surface-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0 0.25rem;
		margin-top: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.surface-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-content-dim, #a1a1aa);
		font-variant-numeric: tabular-nums;
	}
	.surface-actions {
		display: flex;
		gap: 0.4rem;
	}

	/* Edit affordance lives in its own row below the grid so it never crowds
	   the tiles. Chip-shaped: rounded border, transparent fill, quiet at
	   rest, brightens on hover. Centered so it reads as a deliberate action
	   rather than a stray control. */
	.surface-footer {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
		margin-bottom: 1rem;
	}
	.edit-chip {
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		padding: 0.2rem 0.6rem;
		position: relative;
		border-radius: 9999px;
		background: transparent;
		border: 1px solid rgba(255, 255, 255, 0.10);
		color: var(--color-content-dim, #a1a1aa);
		opacity: 0.85;
		cursor: pointer;
		transition: background 180ms var(--ease-standard, ease),
			border-color 180ms, color 180ms, opacity 180ms;
	}
	/* Pill stays small; the tap area is ~32px tall */
	.edit-chip::before {
		content: '';
		position: absolute;
		inset: -0.45rem -0.25rem;
	}
	.edit-chip:hover,
	.edit-chip:focus-visible {
		background: rgba(255, 255, 255, 0.06);
		border-color: rgba(255, 255, 255, 0.28);
		color: var(--color-content, #fafafa);
		opacity: 1;
		outline: none;
	}

	.widget-surface {
		min-height: 4rem;
	}

	/* Wrapper around .grid-stack that owns the centering translateX. Kept
	   separate from the grid element so GridStack's own inline styles
	   (--gs-current-row, computed height) don't fight Svelte's reactive
	   style writes. */
	.grid-center-wrap {
		transition: transform 220ms var(--ease-standard, ease);
	}

	/* App tile — fills its grid cell entirely. Icon centered, name underneath. */
	.app-tile {
		position: relative;
		width: 100%;
		height: 100%;
		display: flex;
	}
	.app-tile-link {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		width: 100%;
		height: 100%;
		padding: 0.4rem 0.25rem;
		border: 1px solid transparent;
		border-radius: 0.6rem;
		text-decoration: none;
		color: var(--color-content, #e4e4e7);
		transition: background 200ms var(--ease-standard, ease), border-color 200ms var(--ease-standard, ease);
		/* Long-press opens our menu; suppress iOS's link preview and text selection */
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}
	/* The same glass pill as the header's clock and weather. */
	.app-tile-link:hover,
	.app-tile-link.menu-open {
		background: var(--input-bg);
		border-color: var(--glass-border);
	}
	.app-tile-icon {
		width: 44px;
		height: 44px;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.06);
		flex-shrink: 0;
	}
	/* Health: the dot sits outside the icon's clip and outside the fade. */
	.app-tile-icon-slot {
		position: relative;
		display: flex;
		flex-shrink: 0;
	}
	.app-tile-link.health-faded .app-tile-icon {
		opacity: 0.4;
		filter: grayscale(0.7);
	}
	.health-dot {
		position: absolute;
		top: -3px;
		right: -3px;
		width: 11px;
		height: 11px;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--health-ring, rgba(20, 20, 22, 0.85));
		pointer-events: none;
	}
	:global(body.theme-light) .health-dot {
		--health-ring: #fff;
	}
	.health-dot.health-down {
		background: #ef4444;
	}
	.health-dot.health-slow {
		background: #f59e0b;
	}
	.health-dot.health-failed {
		background: transparent;
		box-shadow: inset 0 0 0 2px #a1a1aa, 0 0 0 2px var(--health-ring, rgba(20, 20, 22, 0.85));
	}
	:global(.health-tip) {
		position: fixed;
		z-index: 60;
		padding: 12px 14px;
		border-radius: var(--radius-xl);
		pointer-events: none;
		text-decoration: none;
		/* The surface is the tile menu's: glass-card menu-surface, so it
		   follows Configure → Appearance → Glass. */
	}
	:global(.health-tip.linked) {
		pointer-events: auto;
		cursor: pointer;
	}
	:global(.health-tip-check) {
		margin-left: auto;
		padding-left: 16px;
		font-size: var(--text-caption);
		text-transform: none;
		letter-spacing: 0;
		white-space: nowrap;
		color: var(--color-content-muted);
		transition: color 150ms;
	}
	:global(.health-tip.linked:hover .health-tip-check) {
		color: var(--color-content);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.app-tile-name {
		font-size: 0.7rem;
		text-align: center;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-content-muted, #d4d4d8);
	}
	.app-tile-remove {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 22px;
		height: 22px;
		border-radius: 9999px;
		background: rgba(0, 0, 0, 0.7);
		color: #fff;
		font-size: 1rem;
		line-height: 1;
		border: none;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		z-index: 5;
	}
	.app-tile-remove:hover {
		background: rgba(220, 38, 38, 0.85);
	}
	/* 22px badge, ~38px hit area */
	.app-tile-remove::before {
		content: '';
		position: absolute;
		inset: -8px;
	}

	/* Drag handle cursor — restricted to the tile itself; the inner link
	   stays clickable when not in edit mode. */
	.gs-drag-handle {
		cursor: grab;
	}
	.gs-drag-handle:active {
		cursor: grabbing;
	}
</style>
