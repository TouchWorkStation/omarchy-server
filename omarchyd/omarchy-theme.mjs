// The Omarchy desktop's own themes: which one is current, its colours, and every theme's
// background pictures, so the web app's Omarchy theme looks like the desktop. Read-only:
// files are only served when they're image files inside Omarchy's theme folders.
import {createHash} from 'node:crypto'
import {readFile, readdir, realpath, stat} from 'node:fs/promises'
import {basename, extname, join} from 'node:path'

const TYPES = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
const idOf = (path) => createHash('sha256').update(path).digest('hex').slice(0, 16)
const HEX = /^#?([0-9a-f]{6})$/i

// "tokyo-night" -> "Tokyo Night"
export const themeLabel = (name) => String(name).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Colours from a theme folder: colors.toml (newer Omarchy) or alacritty.toml (every theme).
export function parseThemeColors(text) {
	const out = {}
	const pick = (key, section) => {
		const scope = section ? (new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(text)?.[1] ?? '') : text
		const m = new RegExp(`^\\s*${key}\\s*=\\s*["']?(#?[0-9a-fA-F]{6})["']?`, 'm').exec(scope)
		return m && HEX.test(m[1]) ? `#${HEX.exec(m[1])[1].toLowerCase()}` : null
	}
	out.background = pick('background', 'colors.primary') ?? pick('background')
	out.foreground = pick('foreground', 'colors.primary') ?? pick('foreground')
	out.accent = pick('accent') ?? pick('blue', 'colors.normal') ?? pick('color4')
	out.dots = [pick('blue', 'colors.normal') ?? pick('color4'), pick('green', 'colors.normal') ?? pick('color2'), pick('yellow', 'colors.normal') ?? pick('color3'), pick('red', 'colors.normal') ?? pick('color1')].filter(Boolean)
	return out
}

export function createOmarchyTheme({home}) {
	const config = join(home, '.config', 'omarchy')
	const share = join(home, '.local', 'share', 'omarchy')
	let index = new Map() // id -> path, refreshed by list()

	async function currentName() {
		const named = (await readFile(join(config, 'current', 'theme.name'), 'utf8').catch(() => '')).trim()
		if (named) return named
		const real = await realpath(join(config, 'current', 'theme')).catch(() => null)
		return real ? basename(real) : null
	}
	const images = async (dir) =>
		(await readdir(dir, {withFileTypes: true}).catch(() => []))
			.filter((e) => (e.isFile() || e.isSymbolicLink()) && TYPES[extname(e.name).toLowerCase()])
			.map((e) => join(dir, e.name))
			.sort()

	// Every theme Omarchy has (built-in and your own), each with its backgrounds.
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
		for (const root of [join(share, 'themes'), join(config, 'themes')]) {
			for (const e of await readdir(root, {withFileTypes: true}).catch(() => [])) {
				if (e.isDirectory() || e.isSymbolicLink()) await add(e.name, join(root, e.name, 'backgrounds'))
			}
		}
		// Backgrounds you added for a theme (Omarchy keeps them in ~/.config/omarchy/backgrounds/<theme>).
		for (const e of await readdir(join(config, 'backgrounds'), {withFileTypes: true}).catch(() => [])) {
			if (e.isDirectory()) await add(e.name, join(config, 'backgrounds', e.name))
		}
		const current = await currentName()
		if (current) await add(current, join(config, 'current', 'theme', 'backgrounds'))
		const currentBg = await realpath(join(config, 'current', 'background')).catch(() => null)
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

	async function colors() {
		for (const f of ['colors.toml', 'alacritty.toml']) {
			const text = await readFile(join(config, 'current', 'theme', f), 'utf8').catch(() => null)
			if (text) return parseThemeColors(text)
		}
		return null
	}

	// Serve one background by id ("current" = the desktop's background right now).
	async function serve(id, res) {
		let path = null
		if (id === 'current') path = await realpath(join(config, 'current', 'background')).catch(() => null)
		else if (/^[0-9a-f]{16}$/.test(id)) {
			if (!index.has(id)) await list()
			path = index.get(id) ?? null
		}
		const type = path && TYPES[extname(path).toLowerCase()]
		if (!type || !(await stat(path).then((s) => s.isFile(), () => false))) {
			res.writeHead(404)
			return res.end()
		}
		const data = await readFile(path)
		res.writeHead(200, {'content-type': type, 'content-length': data.length, 'cache-control': id === 'current' ? 'no-cache' : 'public, max-age=86400'})
		res.end(data)
	}

	return {list, serve, colors}
}
