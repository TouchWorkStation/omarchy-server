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
	assert.deepEqual(l.colors, {background: '#1a1b26', foreground: '#a9b1d6', accent: '#7aa2f7', dots: ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e'], palette: l.colors.palette})
	assert.deepEqual([l.colors.palette.blue, l.colors.palette.green, l.colors.palette.red], ['#7aa2f7', '#9ece6a', '#f7768e'])

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

test('themes: current Omarchy layout (~/.local/state), switching, getting and removing through Omarchy’s commands', async () => {
	const home = join(root, 'home2')
	const omarchy = join(root, 'omarchy')
	for (const t of ['tokyo-night', 'nord']) {
		await mkdir(join(omarchy, 'themes', t, 'backgrounds'), {recursive: true})
		await writeFile(join(omarchy, 'themes', t, 'colors.toml'), 'accent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\nred = "#f7768e"\ngreen = "#9ece6a"\nyellow = "#e0af68"\nblue = "#7aa2f7"\n')
		await writeFile(join(omarchy, 'themes', t, 'backgrounds', '1.webp'), 'img')
	}
	await mkdir(join(omarchy, 'bin'), {recursive: true})
	for (const b of ['omarchy-theme-set', 'omarchy-theme-install', 'omarchy-theme-remove']) await writeFile(join(omarchy, 'bin', b), '#!/bin/sh\n', {mode: 0o755})
	await mkdir(join(home, '.config/omarchy/themes/dracula'), {recursive: true})
	await writeFile(join(home, '.config/omarchy/themes/dracula/colors.toml'), 'background = "#282a36"\n')
	const state = join(home, '.local/state/omarchy/current')
	await mkdir(state, {recursive: true})
	await symlink(join(omarchy, 'themes/nord'), join(state, 'theme'))
	await writeFile(join(state, 'theme.name'), 'nord\n')
	await symlink(join(omarchy, 'themes/nord/backgrounds/1.webp'), join(state, 'background'))
	const ran = []
	const t = createOmarchyTheme({home, env: {OMARCHY_PATH: omarchy, PATH: '/usr/bin'}, run: async (cmd, args) => ran.push([cmd.split('/').pop(), ...args])})

	const list = await t.themes()
	assert.equal(list.available, true)
	assert.equal(list.current, 'nord')
	assert.deepEqual(list.installed.map((x) => [x.slug, x.user, x.current]), [['dracula', true, false], ['nord', false, true], ['tokyo-night', false, false]])
	assert.deepEqual(list.installed[1].colors.dots, ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e'])
	assert.ok(list.more.length > 100 && !list.more.some((m) => m.slug === 'dracula'), 'the manual’s list, minus what’s installed')
	assert.equal((await t.list()).theme, 'nord', 'backgrounds follow the current layout too')

	await t.setTheme('tokyo-night')
	await assert.rejects(t.setTheme('../../etc'), /isn’t installed/)
	await t.installTheme('monokai')
	await assert.rejects(t.installTheme('https://evil.example/x'), /isn’t in the Omarchy theme list/)
	await assert.rejects(t.removeTheme('nord'), /Only themes you added/)
	await t.removeTheme('dracula')
	await new Promise((r) => setTimeout(r, 10))
	assert.deepEqual(ran, [['omarchy-theme-set', 'tokyo-night'], ['omarchy-theme-install', 'https://github.com/bjarneo/omarchy-monokai-theme'], ['omarchy-theme-remove', 'dracula']])
})
