// Unit tests for apps[].links, the extra entries in a tile's right-click menu.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppsFromConfig, menuLinks } from '../src/lib/apps.js';

test('keeps labelled http(s) links, trimmed and in order', () => {
	const links = menuLinks({
		links: [
			{ label: ' Archive copy ', url: ' http://192.168.10.151:3010 ' },
			{ label: 'Docs', url: 'https://docs.example.com' }
		]
	});
	assert.deepEqual(links, [
		{ label: 'Archive copy', url: 'http://192.168.10.151:3010' },
		{ label: 'Docs', url: 'https://docs.example.com' }
	]);
});

test('drops entries that are not safe, labelled http(s) links', () => {
	const links = menuLinks({
		links: [
			null,
			{ label: 'No url' },
			{ url: 'https://no-label.example.com' },
			{ label: 'Script', url: 'javascript:alert(1)' },
			{ label: 'Data', url: 'data:text/html,hi' },
			{ label: 'Relative', url: '/somewhere' },
			{ label: 'Ok', url: 'https://ok.example.com' }
		]
	});
	assert.deepEqual(links, [{ label: 'Ok', url: 'https://ok.example.com' }]);
	assert.deepEqual(menuLinks({ links: 'nope' }), []);
	assert.deepEqual(menuLinks({}), []);
});

test('caps the label length and the number of links', () => {
	const many = Array.from({ length: 12 }, (_, i) => ({ label: 'x'.repeat(100), url: `https://a.example.com/${i}` }));
	const links = menuLinks({ links: many });
	assert.equal(links.length, 8);
	assert.equal(links[0].label.length, 60);
});

test('built apps carry their links, and an empty list when there are none', () => {
	const { apps } = buildAppsFromConfig([
		{ id: 'a', name: 'A', url: 'http://a', links: [{ label: 'Second copy', url: 'http://b' }] },
		{ id: 'b', name: 'B', url: 'http://b' }
	]);
	assert.deepEqual(apps[0].links, [{ label: 'Second copy', url: 'http://b' }]);
	assert.deepEqual(apps[1].links, []);
});
