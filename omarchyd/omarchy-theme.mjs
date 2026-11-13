// The Omarchy desktop's own themes: which one is current, its colours, every theme's
// background pictures, and switching, installing and removing themes the way the Omarchy
// menu does (through Omarchy's own commands). Files are only served when they're image files
// inside Omarchy's theme folders.
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {access, readFile, readdir, realpath, stat} from 'node:fs/promises'
import {basename, extname, join} from 'node:path'
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)
const EXTRA = require('./omarchy-extra-themes.json')

const TYPES = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
const idOf = (path) => createHash('sha256').update(path).digest('hex').slice(0, 16)
const HEX = /^#?([0-9a-f]{6})$/i
const SLUG = /^[a-z0-9_][a-z0-9._+-]{0,80}$/

// "tokyo-night" -> "Tokyo Night" (as omarchy-theme-list shows it)
export const themeLabel = (name) => String(name).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Colours from a theme folder: colors.toml (current Omarchy) or alacritty.toml (older themes).
export function parseThemeColors(text) {
	const out = {}
	const pick = (key, section) => {
		const scope = section ? (new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(text)?.[1] ?? '') : text
		const m = new RegExp(`^\\s*${key}\\s*=\\s*["']?(#?[0-9a-fA-F]{6})["']?`, 'm').exec(scope)
		return m && HEX.test(m[1]) ? `#${HEX.exec(m[1])[1].toLowerCase()}` : null
	}
	out.background = pick('background', 'colors.primary') ?? pick('background') ?? pick('color0')
	out.foreground = pick('foreground', 'colors.primary') ?? pick('foreground') ?? pick('color7')
	out.accent = pick('accent') ?? pick('blue', 'colors.normal') ?? pick('blue') ?? pick('color4')
	// Top-level red/green/… (colors.toml), [colors.normal] (alacritty.toml) or color1…4.
	const tone = (name, n) => pick(name, 'colors.normal') ?? pick(name) ?? pick(`color${n}`)
	out.dots = [tone('blue', 4), tone('green', 2), tone('yellow', 3), tone('red', 1)].filter(Boolean)
	// The whole palette, so Omarchy Server's own icons and colours can follow the desktop's theme.
	const palette = {red: tone('red', 1), green: tone('green', 2), yellow: tone('yellow', 3), blue: tone('blue', 4), magenta: tone('magenta', 5), cyan: tone('cyan', 6), black: tone('black', 0), brightBlack: pick('black', 'colors.bright') ?? pick('color8')}
	if (Object.values(palette).some(Boolean)) out.palette = Object.fromEntries(Object.entries(palette).filter(([, v]) => v))
	return out
}

const exists = (p) => access(p).then(() => true, () => false)

export function createOmarchyTheme({home, run = null, env = process.env}) {
	const config = join(home, '.config', 'omarchy')
	const omarchyPath = env.OMARCHY_PATH || null
	// Where Omarchy keeps "what's on now": ~/.local/state (current releases) or ~/.config (older).
	const STATE = [join(home, '.local', 'state', 'omarchy', 'current'), join(config, 'current')]
	// Built-in themes: the packaged install, or the older git checkout in ~/.local/share.
	const BUILTIN = [...new Set([omarchyPath && join(omarchyPath, 'themes'), '/usr/share/omarchy/themes', join(home, '.local', 'share', 'omarchy', 'themes')].filter(Boolean))]
	const USER_THEMES = join(config, 'themes')
	const BIN = [...new Set([omarchyPath && join(omarchyPath, 'bin'), '/usr/share/omarchy/bin', join(home, '.local', 'share', 'omarchy', 'bin'), join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin'].filter(Boolean))]
	let index = new Map() // background id -> path, refreshed by list()
	const jobs = new Map() // slug -> {state: 'installing'|'switching'|'removing'|'error', error?}

	const stateFile = async (name) => {
		for (const dir of STATE) if (await exists(join(dir, name))) return join(dir, name)
		return null
	}
	async function currentName() {
		const f = await stateFile('theme.name')
		const named = f ? (await readFile(f, 'utf8').catch(() => '')).trim() : ''
		if (named) return named
		const t = await stateFile('theme')
		const real = t ? await realpath(t).catch(() => null) : null
		return real ? basename(real) : null
	}
	const images = async (dir) =>
		(await readdir(dir, {withFileTypes: true}).catch(() => []))
			.filter((e) => (e.isFile() || e.isSymbolicLink()) && TYPES[extname(e.name).toLowerCase()])
			.map((e) => join(dir, e.name))
			.sort()

	// Every theme folder: slug -> {dir, user}. Your own (~/.config/omarchy/themes) win over built-in.
	async function themeDirs() {
		const out = new Map()
		for (const root of [...BUILTIN, USER_THEMES]) {
			for (const e of await readdir(root, {withFileTypes: true}).catch(() => [])) {
				if (!(e.isDirectory() || e.isSymbolicLink()) || !SLUG.test(e.name)) continue
				out.set(e.name, {dir: join(root, e.name), user: root === USER_THEMES})
			}
		}
		return out
	}

	// Backgrounds of every theme (current first), for the wallpaper picker.
	async function list() {
		const themes = new Map()
		const add = async (name, dir) => {
			for (const file of await images(dir)) {
				const real = await realpath(file).catch(() => null)
				if (!real) continue
				const t = themes.get(name) ?? themes.set(name, new Map()).get(name)
				t.set(real, file)
			}
		}
		for (const [slug, {dir}] of await themeDirs()) await add(slug, join(dir, 'backgrounds'))
		// Backgrounds you added for a theme (Omarchy keeps them in ~/.config/omarchy/backgrounds/<theme>).
		for (const e of await readdir(join(config, 'backgrounds'), {withFileTypes: true}).catch(() => [])) {
			if (e.isDirectory()) await add(e.name, join(config, 'backgrounds', e.name))
		}
		const current = await currentName()
		const currentTheme = await stateFile('theme')
		if (current && currentTheme) await add(current, join(currentTheme, 'backgrounds'))
		const bgFile = await stateFile('background')
		const currentBg = bgFile ? await realpath(bgFile).catch(() => null) : null
		const next = new Map()
		const groups = [...themes]
			.sort(([a], [b]) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)))
			.map(([name, files]) => ({
				theme: name,
				label: themeLabel(name),
				items: [...files.keys()].map((real) => {
					const id = idOf(real)
					next.set(id, real)
					return {id, name: basename(real).replace(/\.[^.]+$/, '')}
				}),
			}))
		if (currentBg && TYPES[extname(currentBg).toLowerCase()]) next.set(idOf(currentBg), currentBg)
		index = next
		return {theme: current, label: current ? themeLabel(current) : null, current: currentBg ? idOf(currentBg) : null, colors: await colors(), groups}
	}

	async function colorsIn(dir) {
		for (const f of ['colors.toml', 'alacritty.toml']) {
			const text = await readFile(join(dir, f), 'utf8').catch(() => null)
			if (text) return parseThemeColors(text)
		}
		return null
	}
	async function colors() {
		const dir = await stateFile('theme')
		return dir ? colorsIn(dir) : null
	}

	// Installed themes with their colours, plus the community themes from the Omarchy manual.
	async function themes() {
		const dirs = await themeDirs()
		const current = await currentName()
		const installed = []
		for (const [slug, {dir, user}] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
			const preview = (await exists(join(dir, 'preview.png'))) || (await images(join(dir, 'backgrounds'))).length > 0
			installed.push({slug, name: themeLabel(slug), user, current: slug === current, colors: await colorsIn(dir), preview, ...(jobs.has(slug) ? {job: jobs.get(slug)} : {})})
		}
		const more = EXTRA.themes
			.filter((t) => !dirs.has(t.slug))
			.map((t) => ({slug: t.slug, name: t.name, url: t.url, preview: previewUrl(t.url), ...(jobs.has(t.slug) ? {job: jobs.get(t.slug)} : {})}))
		return {available: !!(await bin('omarchy-theme-set')), current, installed, more, source: EXTRA.source}
	}
	const previewUrl = (url) => {
		const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/.exec(url)
		return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/preview.png` : null
	}

	async function bin(name) {
		for (const dir of BIN) if (await exists(join(dir, name))) return join(dir, name)
		return null
	}
	// Run an Omarchy command inside your desktop session (so Hyprland, the bar and the
	// terminal pick up the change), the way the Omarchy menu runs it.
	async function omarchy(name, args) {
		const cmd = await bin(name)
		if (!cmd) throw Object.assign(new Error('Omarchy’s theme commands weren’t found on this server.'), {code: 'NOT_OMARCHY'})
		const PATH = [...BIN, ...(env.PATH ?? '').split(':')].filter(Boolean).join(':')
		if (run) return run(cmd, args, {PATH})
		const exec = (c, a, extraEnv = {}) =>
			new Promise((resolve, reject) => {
				const p = spawn(c, a, {env: {...env, HOME: home, PATH, ...extraEnv}, stdio: ['ignore', 'ignore', 'pipe']})
				let err = ''
				p.stderr.on('data', (d) => (err += d).length > 4000 && (err = err.slice(-4000)))
				p.on('error', reject)
				p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `${name} failed`))))
			})
		// In the desktop session's environment when systemd can do that; directly otherwise.
		const viaSystemd = await bin('systemd-run')
		if (viaSystemd) {
			try {
				return await exec(viaSystemd, ['--user', '--wait', '--collect', '--quiet', '--pipe', `--setenv=PATH=${PATH}`, ...(omarchyPath ? [`--setenv=OMARCHY_PATH=${omarchyPath}`] : []), cmd, ...args])
			} catch (e) {
				if (!/Failed to (connect|start)/i.test(e.message)) throw e
			}
		}
		return exec(cmd, args)
	}
	const job = (slug, state, work) => {
		jobs.set(slug, {state})
		work.then(
			() => jobs.delete(slug),
			(e) => {
				jobs.set(slug, {state: 'error', error: e.message})
				setTimeout(() => jobs.get(slug)?.state === 'error' && jobs.delete(slug), 5 * 60_000)
			},
		)
	}

	async function setTheme(slug) {
		if (!SLUG.test(String(slug)) || !(await themeDirs()).has(slug)) throw Object.assign(new Error('That theme isn’t installed'), {code: 'NOT_FOUND'})
		if (jobs.get(slug)?.state === 'switching') return true
		job(slug, 'switching', omarchy('omarchy-theme-set', [slug]))
		return true
	}
	// Only themes from the Omarchy manual's list are installed from here.
	async function installTheme(slug) {
		const t = EXTRA.themes.find((x) => x.slug === slug)
		if (!t) throw Object.assign(new Error('That theme isn’t in the Omarchy theme list'), {code: 'NOT_FOUND'})
		if (jobs.has(slug) && jobs.get(slug).state !== 'error') return true
		job(slug, 'installing', omarchy('omarchy-theme-install', [t.url])) // installs, then switches to it
		return true
	}
	async function removeTheme(slug) {
		const d = (await themeDirs()).get(String(slug))
		if (!d?.user) throw Object.assign(new Error('Only themes you added can be removed'), {code: 'PRECONDITION_FAILED'})
		if ((await currentName()) === slug) throw Object.assign(new Error('Switch to another theme before removing this one'), {code: 'PRECONDITION_FAILED'})
		await omarchy('omarchy-theme-remove', [slug])
		return true
	}

	// One background by id ("current" = the desktop's background right now).
	async function serve(id, res) {
		let path = null
		if (id === 'current') {
			const f = await stateFile('background')
			path = f ? await realpath(f).catch(() => null) : null
		} else if (/^[0-9a-f]{16}$/.test(id)) {
			if (!index.has(id)) await list()
			path = index.get(id) ?? null
		}
		return sendImage(path, res, id === 'current' ? 'no-cache' : 'public, max-age=86400')
	}
	// A theme's preview picture (its preview.png, or its first background).
	async function servePreview(slug, res) {
		const d = SLUG.test(String(slug)) ? (await themeDirs()).get(slug) : null
		let path = null
		if (d) path = (await exists(join(d.dir, 'preview.png'))) ? join(d.dir, 'preview.png') : ((await images(join(d.dir, 'backgrounds')))[0] ?? null)
		return sendImage(path && (await realpath(path).catch(() => null)), res, 'public, max-age=3600')
	}
	async function sendImage(path, res, cache) {
		const type = path && TYPES[extname(path).toLowerCase()]
		if (!type || !(await stat(path).then((s) => s.isFile(), () => false))) {
			res.writeHead(404)
			return res.end()
		}
		const data = await readFile(path)
		res.writeHead(200, {'content-type': type, 'content-length': data.length, 'cache-control': cache})
		res.end(data)
	}

	return {list, serve, servePreview, colors, themes, setTheme, installTheme, removeTheme, currentBackground: async () => {
		const f = await stateFile('background')
		return f ? realpath(f).catch(() => null) : null
	}}
}
