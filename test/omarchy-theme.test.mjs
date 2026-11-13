// The Omarchy desktop's themes and backgrounds, as the web app's Omarchy theme reads them.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createOmarchyTheme, parseThemeColors, themeLabel} from '../omarchyd/omarchy-theme.mjs'

const root = await mkdtemp(join(os.tmpdir(), 'omarchy-theme-'))
after(() => rm(root, {recursive: true, force: true}))

const fakeRes = () => {
	const r = {status: 0, headers: {}, body: null}
	return Object.assign(r, {writeHead: (s, h) => ((r.status = s), (r.headers = h ?? {})), end: (b) => (r.body = b ?? null)})
}

test('lists every theme’s backgrounds (current first), its colours, and serves only those files', async () => {
	const home = join(root, 'home')
	const share = join(home, '.local/share/omarchy/themes')
	for (const [t, files] of [['tokyo-night', ['1-scenery.png', '2-city.jpg']], ['catppuccin', ['1-cat.jpg']], ['gruvbox', ['notes.txt']]]) {
		await mkdir(join(share, t, 'backgrounds'), {recursive: true})
		for (const f of files) await writeFile(join(share, t, 'backgrounds', f), `img:${t}/${f}`)
	}
	await writeFile(join(share, 'tokyo-night', 'alacritty.toml'), "[colors.primary]\nbackground = '#1a1b26'\nforeground = '#a9b1d6'\n\n[colors.normal]\nblack = '#32344a'\nred = '#f7768e'\ngreen = '#9ece6a'\nyellow = '#e0af68'\nblue = '#7aa2f7'\n")
	await mkdir(join(home, '.config/omarchy/current'), {recursive: true})
	await symlink(join(share, 'tokyo-night'), join(home, '.config/omarchy/current/theme'))
	await symlink(join(share, 'tokyo-night/backgrounds/2-city.jpg'), join(home, '.config/omarchy/current/background'))

	const t = createOmarchyTheme({home})
	const l = await t.list()
	assert.equal(l.theme, 'tokyo-night')
	assert.equal(l.label, 'Tokyo Night')
	assert.deepEqual(l.groups.map((g) => g.theme), ['tokyo-night', 'catppuccin'], 'current theme first; themes without pictures left out')
	assert.deepEqual(l.groups[0].items.map((i) => i.name), ['1-scenery', '2-city'])
	assert.equal(l.current, l.groups[0].items[1].id, 'the desktop’s current background is marked')
	assert.deepEqual(l.colors, {background: '#1a1b26', foreground: '#a9b1d6', accent: '#7aa2f7', dots: ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e']})

	const one = fakeRes()
	await t.serve(l.groups[1].items[0].id, one)
	assert.equal(one.status, 200)
	assert.equal(one.headers['content-type'], 'image/jpeg')
	assert.equal(String(one.body), 'img:catppuccin/1-cat.jpg')
	const cur = fakeRes()
	await t.serve('current', cur)
	assert.equal(String(cur.body), 'img:tokyo-night/2-city.jpg')
	for (const bad of ['0123456789abcdef', '../../etc/passwd', '']) {
		const r = fakeRes()
		await t.serve(bad, r)
		assert.equal(r.status, 404)
	}
})

test('no Omarchy here: nothing listed, nothing served', async () => {
	const t = createOmarchyTheme({home: join(root, 'empty')})
	const l = await t.list()
	assert.deepEqual(l, {theme: null, label: null, current: null, colors: null, groups: []})
	const r = fakeRes()
	await t.serve('current', r)
	assert.equal(r.status, 404)
})

test('colours from a newer colors.toml, and theme names', () => {
	assert.equal(parseThemeColors('accent = "#89b4fa"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\ncolor1 = "#f38ba8"\ncolor2 = "#a6e3a1"\ncolor3 = "#f9e2af"\ncolor4 = "#89b4fa"\n').accent, '#89b4fa')
	assert.equal(themeLabel('rose-pine_dawn'), 'Rose Pine Dawn')
})
