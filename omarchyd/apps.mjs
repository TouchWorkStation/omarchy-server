// Apps for omarchyd: app stores you add, apps installed from them, and the gateway in front of them.
//
// Engine: rootless Podman, driven by the docker-compose binary through Podman's per-user socket. No
// root, no docker group (which is root-equivalent), and no daemon socket anywhere on the network.
//
// Stores are git repositories in the community-store layout: a store manifest at the root, then one
// folder per app with its manifest and a compose file. omarchyd prefers its own file names
// (omarchy-app-store.yml, omarchy-app.yml) and also reads the older community names, so existing
// stores work unchanged. Each app's compose file declares an `app_proxy` service naming the
// container and port of its web interface; omarchyd removes that service and puts its own gateway
// there instead.
//
// Gateway: each app's public port is served by omarchyd, which forwards only signed-in browsers to
// the app (published on 127.0.0.1 only). A browser proves it's signed in with an app-session cookie
// (HMAC-signed, HttpOnly). It gets one at sign-in, or by a one-time hand-over from the web app when it
// first opens an app. Cookies belong to a host, not a port, so one sign-in covers every app.
import {execFile} from 'node:child_process'
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto'
import {access, cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join, resolve} from 'node:path'
import YAML from 'yaml'

import {RpcError} from './rpc.mjs'

export const APP_COOKIE = 'OMARCHY_APP_SESSION'
const STORE_FILES = ['omarchy-app-store.yml', 'umbrel-app-store.yml']
const APP_FILES = ['omarchy-app.yml', 'umbrel-app.yml']
const COMPOSE_FILES = ['omarchy-compose.yml', 'docker-compose.yml']
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const RESERVED = (p) => p === 7780 || p === 2021 || (p >= 40_000 && p <= 49_999)
const SESSION_DAYS = 30
// Some stores keep icons and screenshots in a separate gallery site, by app id.
// Stores every new Omarchy Server starts with (you can remove them under App Store → Stores). They're
// downloaded from GitHub by your server; nothing from them is copied into Omarchy Server itself.
// TouchWorkStation's own catalog: plain Docker Compose files from each project's official image, with
// original descriptions. Other stores (including Umbrel-format ones) can still be added by hand.
export const DEFAULT_STORES = [{url: 'https://github.com/TouchWorkStation/app-store'}]
const GALLERIES = {}
// Variables omarchyd provides to every app (anything else a compose file needs without a default
// means the app relies on something Omarchy Server doesn't offer yet).
const PROVIDED = new Set(['APP_DATA_DIR', 'APP_DATA_ROOT', 'APP_ID', 'APP_DOMAIN', 'APP_VERSION', 'APP_PROXY_PORT', 'APP_HIDDEN_SERVICE', 'GATEWAY_IP', 'DEVICE_HOSTNAME', 'DEVICE_DOMAIN_NAME', 'APP_PASSWORD', 'APP_SEED', 'UMBREL_ROOT', 'DOCKER_HOST', 'TZ', 'NETWORK_IP', 'TOR_PROXY_IP', 'TOR_PROXY_PORT', 'TOR_DATA_DIR', 'TOR_PASSWORD', 'SERVER_IP', 'DOWNLOADS_DIR', 'VIDEOS_DIR', 'MUSIC_DIR', 'PICTURES_DIR', 'DOCUMENTS_DIR', 'PUID', 'PGID', 'DOCKER_SOCKET'])
// Apps that talk to each other (an app and the apps it needs, or apps with fixed internal
// addresses) share one container network, laid out the way their store expects (10.21.0.0/16).
// Apps that don't stay on a private network of their own.
export const SHARED_NETWORK = 'omarchy_main_network'
// Your folders an app may be given (read-write; an access entry lets the app's user in).
const USER_DIRS = {DOWNLOADS_DIR: 'Downloads', VIDEOS_DIR: 'Videos', MUSIC_DIR: 'Music', PICTURES_DIR: 'Pictures', DOCUMENTS_DIR: 'Documents'}
const serverIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !/^(10\.88|10\.89|172\.1[6-9]|172\.2\d|172\.3[01])\./.test(i.address))?.address ?? '127.0.0.1'
const SHARED_SUBNET = '10.21.0.0/16'
const SHARED_GATEWAY = '10.21.0.1'
// A shared Tor proxy for apps that route through Tor (started the first time one is installed),
// where their store expects it.
const TOR_PROXY_IP = '10.21.21.11'
const TOR_PROXY_PORT = '9050'
const TOR_PASSWORD = 'moneyprintergobrrr' // the control password these store apps are written for
// Container user most store apps run as (PUID/PGID 1000).
const APP_UID = 1000

// Variables a compose file uses with no default, that we don't provide.
// ---- extra access an app asks for -------------------------------------------------------------
// Worked out from the compose file itself (a listing can't leave anything out). Each needs your
// explicit permission when installing; plain apps need none.
export const PERMISSIONS = {
	containers: {label: 'Control your containers', detail: 'It can start, stop, create and delete every container you run (and see their settings and data). Container managers need this.'},
	'low-ports': {label: 'Use network ports below 1024', detail: 'It listens on system ports such as 53 (DNS), 80 or 443. Omarchy Server lets your containers use those ports on this server.'},
	devices: {label: 'Use hardware devices', detail: 'It gets direct access to devices plugged into your server, such as USB sticks or video cards.'},
	network: {label: 'Change networking inside its container', detail: 'It can create network interfaces, routes and firewall rules inside its own container (VPNs need this). It can’t change your server’s own network.'},
	privileged: {label: 'Run with every container permission', detail: 'It runs with all permissions inside its container. Containers here run as you, not as root, so it still can’t become root on your server.'},
}
const SOCKET = /(?:^|\/)(?:docker|podman)\.sock$|\$\{?DOCKER_SOCKET/
export function appPermissions(text) {
	const doc = (() => {
		try {
			return YAML.parse(String(text)) ?? {}
		} catch {
			return {}
		}
	})()
	const found = new Map()
	const add = (id, what) => {
		if (!found.has(id)) found.set(id, new Set())
		if (what) found.get(id).add(String(what))
	}
	for (const [name, s] of Object.entries(doc.services ?? {})) {
		if (!s || typeof s !== 'object' || name === 'app_proxy') continue
		if (s.privileged === true || s.privileged === 'true') add('privileged', name)
		for (const v of s.volumes ?? []) {
			const src = typeof v === 'string' ? v.split(':')[0] : String(v?.source ?? '')
			if (SOCKET.test(src)) add('containers', name)
			else if (/^\/dev(\/|$)/.test(src) && !/^\/dev\/shm/.test(src)) add('devices', src)
		}
		for (const d of s.devices ?? []) add('devices', String(typeof d === 'string' ? d.split(':')[0] : d?.source ?? 'device'))
		for (const c of s.cap_add ?? []) if (/NET_ADMIN|NET_RAW|SYS_MODULE|SYS_ADMIN|ALL/i.test(String(c))) add(/SYS_ADMIN|ALL/i.test(String(c)) ? 'privileged' : 'network', String(c))
		if (s.sysctls && Object.keys(s.sysctls).length) add('network', 'sysctls')
		for (const p of s.ports ?? []) {
			const t = typeof p === 'object' ? String(p.published ?? '') : String(p).split('/')[0]
			const parts = t.split(':')
			const host = Number(parts.length >= 3 ? parts[parts.length - 2] : parts.length === 2 ? parts[0] : NaN)
			if (Number.isInteger(host) && host > 0 && host < 1024) add('low-ports', host)
		}
	}
	return [...found].map(([id, set]) => ({id, ...PERMISSIONS[id], what: [...set].slice(0, 6)}))
}

// Compose-style ${NAME}, $NAME, ${NAME:-default}, ${NAME-default} and ${NAME:?message}.
export function expandVars(text, env) {
	return String(text).replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, name, colon, op, arg, bare) => {
		const v = env[name ?? bare]
		const empty = v === undefined || (colon && v === '')
		if (op === '-') return empty ? arg : v
		if (op === '+') return empty ? '' : arg
		return v ?? ''
	})
}

export function missingVars(text, alsoProvided = []) {
	const out = new Set()
	for (const m of String(text).replace(/\$\$/g, '').matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
		const name = m[1] ?? m[3]
		const rest = m[2] ?? ''
		if (/^:?[-=]/.test(rest)) continue // has a default
		if (!PROVIDED.has(name) && !alsoProvided.includes(name)) out.add(name)
	}
	return [...out]
}

function execP(cmd, args, {env, cwd, timeout = 10 * 60_000} = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, {cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: {...process.env, ...env}}, (error, stdout, stderr) => {
			if (error) {
				error.message = `${cmd}: ${(stderr || error.message).toString().trim().split('\n').slice(-3).join(' ')}`
				return reject(error)
			}
			resolve(stdout.toString())
		})
	})
}
const exists = (p) => access(p).then(() => true, () => false)
const portFree = (port) =>
	new Promise((resolve) => {
		const s = net.createServer()
		s.once('error', () => resolve(false))
		s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)))
	})
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]))

// Read the first of `names` that exists in `dir` as YAML.
async function readYaml(dir, names) {
	for (const n of names) {
		try {
			return {name: n, data: YAML.parse(await readFile(join(dir, n), 'utf8'))}
		} catch (e) {
			if (e.code !== 'ENOENT') throw e
		}
	}
	return null
}

// Turn a store compose file into what omarchyd runs: no app_proxy, the web service published on
// 127.0.0.1 only. Returns the compose text and where the gateway should forward to.
// The apps `id` needs, dependencies first (a depth-first post-order).
function orderNeeds(id, byId, seen = new Set(), out = []) {
	for (const d of (byId.get(id)?.a.dependencies ?? []).filter((x) => typeof x === 'string')) {
		if (seen.has(d)) continue
		seen.add(d)
		orderNeeds(d, byId, seen, out)
		out.push(d)
	}
	return out
}
const varName = (v) => /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(String(v ?? '').trim())?.[1] ?? null
export function prepareCompose(appId, text, allocatePort, {shared = false, vars = {}, web = null} = {}) {
	const doc = YAML.parse(text) ?? {}
	const services = doc.services ?? {}
	const proxy = services.app_proxy?.environment ?? {}
	delete services.app_proxy
	delete doc.version
	for (const [key, s] of Object.entries(services)) {
		if (!s || typeof s !== 'object') continue
		if (Array.isArray(s.depends_on)) s.depends_on = s.depends_on.filter((d) => d !== 'app_proxy')
		else if (s.depends_on && typeof s.depends_on === 'object') delete s.depends_on.app_proxy
		// Store apps find their own services as <app>_<service>_1 (e.g. immich_postgres_1).
		if (!s.container_name && s.network_mode !== 'host') s.container_name = `${appId}_${key}_1`
	}
	if (shared) doc.networks = {...(doc.networks ?? {}), default: {name: SHARED_NETWORK, external: true}}
	// APP_PORT / APP_HOST may name a variable from the app's exports.sh (e.g. $APP_MEMPOOL_PORT).
	const resolved = (v) => {
		const n = varName(v)
		return n && vars[n] !== undefined ? String(vars[n]) : String(v ?? '')
	}
	const appPort = Number(resolved(proxy.APP_PORT))
	const host = String(proxy.APP_HOST ?? '').trim()
	let internalPort = null
	if (Number.isInteger(appPort) && appPort > 0) {
		if (/^\$\{?GATEWAY_IP\}?$/.test(host) || host === '127.0.0.1') {
			internalPort = appPort // the app is on the host network, bound to 127.0.0.1 (GATEWAY_IP)
		} else {
			const name = host.replace(new RegExp(`^${appId}[_-]`), '').replace(/[_-]\d+$/, '')
			const byContainer = Object.keys(services).find((k) => services[k]?.container_name === host)
			// The web service named by its fixed address (APP_HOST: $APP_X_IP, ipv4_address: $APP_X_IP).
			const hostVar = varName(host)
			const byAddress = hostVar ? Object.keys(services).find((k) => varName(services[k]?.networks?.default?.ipv4_address) === hostVar) : null
			const key = services[host] ? host : services[name] ? name : byContainer ? byContainer : byAddress ? byAddress : Object.keys(services).length === 1 ? Object.keys(services)[0] : null
			if (!key) throw new Error(`Can’t tell which service is the web interface (${host || 'none named'})`)
			internalPort = allocatePort()
			services[key].ports = [...(services[key].ports ?? []), `127.0.0.1:${internalPort}:${appPort}`]
		}
	}
	// TouchWorkStation listings are plain Docker Compose files: the listing names its web service and
	// port (web: {service, port}). Any host port the file publishes for it (so it also runs on its own
	// with `docker compose up`) gives way to Omarchy Server's private one behind the sign-in.
	if (!internalPort && web && services[web.service] && Number.isInteger(web.port)) {
		const svc = services[web.service]
		if (svc.network_mode === 'host') {
			internalPort = null // holds its own port, like Home Assistant
		} else {
			const containerPort = (p) => Number(String(typeof p === 'object' ? p.target : p).split('/')[0].split(':').pop())
			svc.ports = (svc.ports ?? []).filter((p) => containerPort(p) !== web.port)
			internalPort = allocatePort()
			svc.ports.push(`127.0.0.1:${internalPort}:${web.port}`)
		}
	}
	doc.services = services
	return {text: YAML.stringify(doc), internalPort}
}

export function createApps({dataDir, home = os.homedir(), webPort = 7780, run = execP, gatewayHost = '0.0.0.0', allowFileStores = false, firewall = null, defaultStores = DEFAULT_STORES}) {
	const base = join(dataDir, 'apps')
	const storesDir = join(base, 'stores')
	const installedDir = join(base, 'installed')
	const stateFile = join(base, 'apps.json')
	const engineEnv = {DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/podman/podman.sock`}

	let state = {stores: [], apps: [], recent: []}
	let secret
	const busy = new Map() // appId -> {state, progress}
	const gateways = new Map() // appId -> {server, port}
	const tickets = new Map() // one-time hand-overs from the web app
	let registryCache = null

	const ready = (async () => {
		await mkdir(storesDir, {recursive: true, mode: 0o700})
		await mkdir(installedDir, {recursive: true, mode: 0o700})
		try {
			state = {...state, ...JSON.parse(await readFile(stateFile, 'utf8'))}
		} catch {}
		const sf = join(base, 'secret')
		try {
			secret = await readFile(sf)
		} catch {
			secret = randomBytes(32)
			await writeFile(sf, secret, {mode: 0o600})
		}
		// First start: add the default stores (they download the first time the App Store opens).
		if (!state.defaultsAdded) {
			for (const d of defaultStores) if (!state.stores.some((x) => x.url.toLowerCase() === d.url.toLowerCase())) state.stores.push({url: d.url, ...(d.name ? {name: d.name} : {}), syncedAt: 0})
			state.defaultsAdded = true
			await save()
		}
		// Omarchy Server uses only the TouchWorkStation store: remove the Umbrel store servers were given
		// before (once). Apps already installed from it keep running; they just get no updates from it.
		if (!state.umbrelStoreRemoved) {
			const old = state.stores.filter((x) => /github\.com\/getumbrel\/umbrel-apps(\.git)?$/i.test(x.url))
			for (const x of old) await rm(storeDir(x.url), {recursive: true, force: true}).catch(() => {})
			state.stores = state.stores.filter((x) => !old.includes(x))
			for (const d of defaultStores) if (!state.stores.some((x) => x.url.toLowerCase() === d.url.toLowerCase())) state.stores.unshift({url: d.url, syncedAt: 0})
			state.umbrelStoreRemoved = true
			await save()
		}
		for (const a of state.apps) if (a.state === 'installing') Object.assign(a, {state: 'error', error: 'Install was interrupted. Uninstall it and install again.'})
		for (const a of state.apps) if (a.port && a.state !== 'error') await openGateways(a).catch((e) => console.error('[omarchyd] gateway', a.id, e.message))
	})()
	const save = async () => {
		const tmp = `${stateFile}.${process.pid}.tmp`
		await writeFile(tmp, JSON.stringify(state, null, 2), {mode: 0o600})
		await rename(tmp, stateFile)
	}
	const appDir = (id) => join(installedDir, id)
	const project = (id) => `omarchy-${id}`

	// ---- app sessions ---------------------------------------------------------------------------
	const sign = (body) => createHmac('sha256', secret).update(body).digest('base64url')
	function issueSession(userId) {
		// g: the person's pass generation; signing out other devices moves it on, ending older passes.
		const body = Buffer.from(JSON.stringify({u: userId, e: Date.now() + SESSION_DAYS * 86_400_000, g: state.passGen?.[userId] ?? 0})).toString('base64url')
		return `v1.${body}.${sign(body)}`
	}
	function checkSession(token) {
		const [v, body, mac] = String(token ?? '').split('.')
		if (v !== 'v1' || !body || !mac) return null
		const want = Buffer.from(sign(body))
		const got = Buffer.from(mac)
		if (want.length !== got.length || !timingSafeEqual(want, got)) return null
		try {
			const p = JSON.parse(Buffer.from(body, 'base64url').toString())
			return p.e > Date.now() && (p.g ?? 0) === (state.passGen?.[p.u] ?? 0) ? p : null
		} catch {
			return null
		}
	}
	const sessionCookie = (token) => `${APP_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`

	// ---- gateway --------------------------------------------------------------------------------
	function forwardHeaders(req) {
		const h = {...req.headers}
		const cookies = (h.cookie ?? '')
			.split(';')
			.map((c) => c.trim())
			.filter((c) => c && !c.startsWith(`${APP_COOKIE}=`))
		if (cookies.length) h.cookie = cookies.join('; ')
		else delete h.cookie
		h['x-forwarded-for'] = req.socket.remoteAddress ?? ''
		h['x-forwarded-proto'] = 'http'
		h['x-forwarded-host'] = req.headers.host ?? ''
		return h
	}
	const hostOnly = (req) => {
		const h = req.headers.host ?? 'localhost'
		return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
	}
	// Apps open inside Omarchy Server's own page (desktop windows, the full-screen app view). Many
	// apps forbid being shown inside another page; for their responses through this gateway that is
	// relaxed to exactly one embedder: the Omarchy Server web app on this same host. Nothing else changes.
	const frameable = (headers, host) => {
		const out = {...headers}
		delete out['x-frame-options']
		const allow = `frame-ancestors 'self' http://${host}:${webPort} https://${host}:${webPort}`
		const csp = []
			.concat(out['content-security-policy'] ?? [])
			.map((v) =>
				String(v)
					.split(';')
					.map((d) => d.trim())
					.filter((d) => d && !/^frame-ancestors\b/i.test(d))
					.join('; '),
			)
			.filter(Boolean)
		out['content-security-policy'] = csp.length ? [`${csp[0]}; ${allow}`, ...csp.slice(1)] : allow
		return out
	}
	const safePath = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/')

	// The sign-in gateway in front of an app. Normally it owns the app's port and forwards to the
	// app's private one (127.0.0.1:internalPort). Apps that hold their own port themselves (host
	// network: Home Assistant, Plex, Pi-hole…) get a "view" gateway on a port of its own instead, so
	// they can still be shown inside Omarchy Server; it passes requests on unchanged, without
	// proxy headers (some apps, like Home Assistant, refuse requests that claim to come via a proxy).
	const gatewayKey = (id, view) => (view ? `${id}:view` : id)
	async function openGateway(app, {view = false} = {}) {
		const key = gatewayKey(app.id, view)
		if (gateways.has(key)) return
		const listenPort = view ? app.viewPort : app.port
		const target = view ? app.port : app.internalPort
		const headersFor = (req) => {
			const h = forwardHeaders(req)
			if (view) for (const k of Object.keys(h)) if (k.startsWith('x-forwarded-')) delete h[k]
			return h
		}
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://x')
			if (url.pathname === '/__omarchy/enter') {
				const t = tickets.get(url.searchParams.get('t') ?? '')
				tickets.delete(url.searchParams.get('t') ?? '')
				if (!t || t.exp < Date.now() || t.appId !== app.id) {
					res.writeHead(403, {'content-type': 'text/plain'})
					return res.end('This link has expired. Open the app again from Omarchy Server.')
				}
				res.writeHead(302, {'set-cookie': sessionCookie(issueSession(t.userId)), location: safePath(url.searchParams.get('r')), 'cache-control': 'no-store'})
				return res.end()
			}
			if (!checkSession(parseCookies(req.headers.cookie)[APP_COOKIE])) {
				// Not signed in on this browser yet: the web app hands it over (or asks it to sign in).
				const back = `http://${hostOnly(req)}:${webPort}/api/app-enter?app=${encodeURIComponent(app.id)}&r=${encodeURIComponent(safePath(req.url))}${view ? '&view=1' : ''}`
				res.writeHead(302, {location: back, 'cache-control': 'no-store'})
				return res.end()
			}
			const up = http.request({host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: headersFor(req), timeout: 120_000}, (r) => {
				up.setTimeout(0) // it answered: long-lived responses (live updates, downloads) are fine
				res.writeHead(r.statusCode ?? 502, frameable(r.headers, hostOnly(req)))
				r.pipe(res)
			})
			up.on('timeout', () => up.destroy(new Error('timeout')))
			up.on('error', () => {
				if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain'})
				res.end(`${app.name ?? app.id} isn’t answering yet. If it just started, give it a moment.`)
			})
			req.pipe(up)
		})
		server.on('upgrade', (req, socket, head) => {
			if (!checkSession(parseCookies(req.headers.cookie)[APP_COOKIE])) {
				socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
				return
			}
			const up = net.connect(target, '127.0.0.1', () => {
				const h = headersFor(req)
				const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))]
				up.write(`${lines.join('\r\n')}\r\n\r\n`)
				if (head?.length) up.write(head)
				up.pipe(socket)
				socket.pipe(up)
			})
			up.on('error', () => socket.destroy())
			socket.on('error', () => up.destroy())
		})
		await new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(listenPort, gatewayHost, resolve)
		})
		gateways.set(key, {server, port: listenPort})
	}
	// A port for an app's view gateway (7900-7999), the same one each time where possible.
	async function viewPortFor(app) {
		const taken = new Set(state.apps.filter((a) => a.id !== app.id).map((a) => a.viewPort))
		const start = parseInt(createHash('sha256').update(app.id).digest('hex').slice(0, 4), 16) % 100
		for (let i = 0; i < 100; i++) {
			const p = 7900 + ((start + i) % 100)
			if (!taken.has(p) && (app.viewPort === p || (await portFree(p)))) return p
		}
		return null
	}
	// Open whichever gateway the app needs (after install, update and at start-up).
	async function openGateways(app) {
		// Extra ports the listing says must be reachable (sync, torrents, SSH…).
		for (const p of app.openPorts ?? []) await firewall?.open(p)
		if (!app.port) return
		if (app.internalPort) {
			delete app.viewPort
			await openGateway(app)
			await firewall?.open(app.port)
			return
		}
		// The app holds its own port (host network, e.g. Home Assistant on 8123): Open goes straight
		// there, so that port has to be let through the firewall too.
		await firewall?.open(app.port)
		app.viewPort = app.viewPort ?? (await viewPortFor(app))
		if (!app.viewPort) return
		await openGateway(app, {view: true})
		await firewall?.open(app.viewPort)
	}
	function closeGateway(id) {
		for (const key of [id, gatewayKey(id, true)]) {
			const g = gateways.get(key)
			if (!g) continue
			g.server.close()
			g.server.closeAllConnections?.()
			gateways.delete(key)
		}
	}

	// ---- stores ---------------------------------------------------------------------------------
	const storeDir = (url) => join(storesDir, createHash('sha256').update(url).digest('hex').slice(0, 16))
	const normalize = (url) => String(url ?? '').trim().replace(/\/+$/, '')
	function checkUrl(url) {
		if (/^https:\/\/[\w.-]+(:\d+)?\/[\w.\-~/]+$/.test(url)) return
		if (allowFileStores && /^file:\/\//.test(url)) return
		throw new RpcError('BAD_REQUEST', 'Enter the store’s https:// address, e.g. https://github.com/someone/app-store')
	}
	async function loadStore(url) {
		const dir = storeDir(url)
		let meta = (await readYaml(dir, STORE_FILES))?.data
		const gallery = GALLERIES[url.toLowerCase().replace(/\.git$/, '')] ?? (typeof meta?.gallery === 'string' && /^https:\/\//.test(meta.gallery) ? meta.gallery.replace(/\/+$/, '') : null)
		const apps = []
		// First pass: every app and the variables each one's exports.sh provides (apps that need
		// another app read that app's variables, such as its address and passwords).
		const found = []
		for (const entry of await readdir(dir, {withFileTypes: true})) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue
			const m = await readYaml(join(dir, entry.name), APP_FILES).catch(() => null)
			if (!m?.data?.id || m.data.id !== entry.name || !APP_ID.test(m.data.id)) continue
			const c = await readYaml(join(dir, entry.name), COMPOSE_FILES).catch(() => null)
			if (!c) continue
			const compose = await readFile(join(dir, entry.name, c.name), 'utf8')
			const exportsText = await readFile(join(dir, entry.name, 'exports.sh'), 'utf8').catch(() => '')
			// `export NAME=…`, a bare `export NAME`, or one written out for later (echo "export NAME=…" >> .env).
			const exported = [...exportsText.matchAll(/\bexport\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((m) => m[1])
			found.push({a: m.data, entry, compose, exported})
		}
		const byId = new Map(found.map((f) => [f.a.id, f]))
		// Everything an app needs, all the way down (bitcoin → lightning → …).
		const needsOf = (id, seen = new Set()) => {
			for (const d of (byId.get(id)?.a.dependencies ?? []).filter((x) => typeof x === 'string')) {
				if (seen.has(d)) continue
				seen.add(d)
				needsOf(d, seen)
			}
			return seen
		}
		const neededByOthers = new Set(found.flatMap((f) => (f.a.dependencies ?? []).filter((x) => typeof x === 'string')))
		for (const {a, entry, compose, exported} of found) {
			const deps = (a.dependencies ?? []).filter((x) => typeof x === 'string')
			const all = [...needsOf(a.id)]
			const absent = all.filter((d) => !byId.has(d))
			const fromDeps = all.flatMap((d) => byId.get(d)?.exported ?? [])
			const missing = missingVars(compose, [...exported, ...fromDeps])
			const unsupported = absent.length ? `Needs ${absent.join(', ')}, which isn’t in this store.` : null
			// Settings it can use but doesn't require: from another app it works with when that app is
			// installed (e.g. Mempool), or ones nothing here provides. It installs either way; they stay empty.
			const optionalFrom = [...new Set(missing.flatMap((v) => found.filter((f) => f.exported.includes(v)).map((f) => String(f.a.name ?? f.a.id))))]
			const unknown = missing.filter((v) => !found.some((f) => f.exported.includes(v)))
			const caution = optionalFrom.length
				? `Works with ${optionalFrom.join(', ')} too: install ${optionalFrom.length > 1 ? 'them' : 'it'} to use those features.`
				: unknown.length
					? `Some features may not work here: it expects settings Omarchy Server doesn’t have (${unknown.slice(0, 3).join(', ')}).`
					: null
			const media = (f) => (typeof f === 'string' && /^https:\/\//.test(f) ? f : gallery && typeof f === 'string' && /^[\w.-]+$/.test(f) ? `${gallery}/${a.id}/${f}` : null)
			apps.push({
				id: a.id,
				name: String(a.name ?? a.id),
				tagline: a.tagline,
				icon: media(a.icon) ?? (gallery ? `${gallery}/${a.id}/icon.svg` : undefined),
				category: a.category,
				version: a.version !== undefined ? String(a.version) : undefined,
				port: Number(a.port) || undefined,
				path: typeof a.path === 'string' ? a.path : '',
				description: a.description,
				developer: a.developer,
				website: a.website,
				gallery: (a.gallery ?? []).map(media).filter(Boolean),
				releaseNotes: a.releaseNotes,
				dependencies: deps,
				// Everything installed along with it, in install order (what it needs comes first).
				...(all.length ? {needs: orderNeeds(a.id, byId)} : {}),
				...(Array.isArray(a.implements) ? {implements: a.implements.filter((x) => typeof x === 'string')} : {}),
				shared: deps.length > 0 || neededByOthers.has(a.id) || /ipv4_address/.test(compose),
				defaultUsername: a.defaultUsername || undefined,
				defaultPassword: a.defaultPassword || undefined,
				deterministicPassword: a.deterministicPassword === true,
				permissions: appPermissions(compose).map((p) => p.id),
				...(Array.isArray(a.openPorts) ? {openPorts: a.openPorts.map(Number).filter((n) => Number.isInteger(n) && n >= 1024 && n <= 65535).slice(0, 16)} : {}),
				...(a.web && typeof a.web.service === 'string' && Number.isInteger(Number(a.web.port)) ? {web: {service: a.web.service, port: Number(a.web.port)}} : {}),
				...(unsupported ? {unsupported} : {}),
				...(caution ? {caution} : {}),
				folder: join(dir, entry.name),
			})
		}
		if (!meta?.id) {
			// No store manifest: a plain repository of app folders. Name it after the repository.
			if (!apps.length) throw new RpcError('BAD_REQUEST', 'That repository isn’t an app store (no apps found in it)')
			const slug = url.replace(/\.git$/, '').split('/').filter(Boolean).slice(-2).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-')
			const repo = url.replace(/\.git$/, '').split('/').pop() ?? 'store'
			meta = {id: slug, name: repo.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
		}
		return {url, meta: {id: String(meta.id), name: String(meta.name ?? meta.id)}, apps}
	}
	async function syncStore(url) {
		const dir = storeDir(url)
		if (await exists(join(dir, '.git'))) await run('git', ['-C', dir, 'pull', '--ff-only', '--depth', '1'], {timeout: 120_000})
		else await run('git', ['clone', '--depth', '1', '--', url, dir], {timeout: 120_000})
	}
	async function registry({refresh = false} = {}) {
		await ready
		if (registryCache && !refresh && Date.now() - registryCache.at < 60 * 60_000) return registryCache.list
		const list = []
		for (const s of state.stores) {
			if (refresh || Date.now() - (s.syncedAt ?? 0) > 6 * 60 * 60_000) {
				try {
					await syncStore(s.url)
					s.syncedAt = Date.now()
				} catch {}
			}
			try {
				const loaded = await loadStore(s.url)
				if (s.name) loaded.meta.name = s.name
				s.meta = loaded.meta
				list.push(loaded)
			} catch {}
		}
		await save()
		registryCache = {at: Date.now(), list}
		return list
	}
	// An app's listing. An installed app stays with the store it came from (two stores can list the
	// same id with different folders and settings, and an update must never switch between them).
	const findInRegistry = async (id) => {
		const stores = await registry()
		const withStore = (a, st) => (a ? {...a, store: st.url} : null)
		const installed = state.apps.find((x) => x.id === id)
		if (installed?.store) {
			const st = stores.find((x) => x.url.toLowerCase() === installed.store.toLowerCase())
			return withStore(st?.apps.find((x) => x.id === id), st ?? {}) ?? null
		}
		if (installed) {
			// Installed before stores were recorded: those came from Umbrel-format listings, so prefer one.
			for (const st of stores) {
				const a = st.apps.find((x) => x.id === id && !x.web)
				if (a) return withStore(a, st)
			}
		}
		for (const st of stores) {
			const a = st.apps.find((x) => x.id === id)
			if (a) return withStore(a, st)
		}
		return null
	}

	// ---- engine ---------------------------------------------------------------------------------
	// Per-app secrets: HMAC-SHA256 of an identifier with this server's secret (the same scheme the
	// store apps' own exports.sh scripts use through derive_entropy).
	// A key just for app secrets, separate from the one that signs app sessions, so nothing an app
	// or its exports.sh sees can be used to forge a sign-in.
	const entropyKey = () => createHmac('sha256', secret).update('omarchy-server app entropy v1').digest('hex')
	const deriveEntropy = (identifier) => createHmac('sha256', entropyKey()).update(identifier).digest('hex')
	const appPassword = (id) => deriveEntropy(`app-${id}-seed-APP_PASSWORD`)
	function composeEnv(app) {
		const dir = appDir(app.id)
		const host = os.hostname().split('.')[0]
		// Variables from every installed app (an app reads those of the apps it needs), its own last.
		const others = Object.assign({}, ...state.apps.filter((a) => a.id !== app.id).map((a) => a.exports ?? {}))
		return {
			...engineEnv,
			...others,
			...(app.exports ?? {}),
			NETWORK_IP: SHARED_SUBNET.split('/')[0],
			TOR_PROXY_IP,
			TOR_PROXY_PORT,
			TOR_PASSWORD,
			TOR_DATA_DIR: join(base, 'shared-root', 'tor', 'data'),
			APP_DATA_DIR: dir,
			APP_DATA_ROOT: dir,
			APP_ID: app.id,
			APP_DOMAIN: `${host}.local`,
			APP_VERSION: String(app.version ?? ''),
			APP_PROXY_PORT: String(app.port ?? ''),
			APP_HIDDEN_SERVICE: 'not-enabled.onion',
			TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
			GATEWAY_IP: '127.0.0.1',
			DEVICE_HOSTNAME: host,
			DEVICE_DOMAIN_NAME: `${host}.local`,
			APP_PASSWORD: appPassword(app.id),
			APP_SEED: deriveEntropy(`app-${app.id}-seed`),
			// Community-store compose files reach shared folders through this root; it maps
			// <root>/data/storage/downloads to your Downloads folder.
			UMBREL_ROOT: join(base, 'shared-root'),
			// TouchWorkStation listings: your own folders and this server's address, by name.
			...Object.fromEntries(Object.entries(USER_DIRS).map(([k, d]) => [k, join(home, d)])),
			SERVER_IP: serverIp(),
			DOCKER_SOCKET: engineEnv.DOCKER_HOST.replace(/^unix:\/\//, ''),
			PUID: String(APP_UID),
			PGID: String(APP_UID),
		}
	}
	async function sharedRoot() {
		const storage = join(base, 'shared-root', 'data', 'storage')
		await mkdir(storage, {recursive: true})
		const link = join(storage, 'downloads')
		if (!(await exists(link))) {
			await mkdir(join(home, 'Downloads'), {recursive: true})
			await symlink(join(home, 'Downloads'), link).catch(() => {})
		}
	}
	const compose = (app, ...args) => run('docker-compose', ['-p', project(app.id), '-f', join(appDir(app.id), 'compose.omarchy.yml'), ...args], {env: composeEnv(app), cwd: appDir(app.id)})

	// Bind-mount sources that don't exist yet are folders the app expects to own (Podman won't
	// create them the way Docker does).
	async function createBindSources(app, text) {
		const env = composeEnv(app)
		const shared = join(base, 'shared-root')
		const doc = YAML.parse(text) ?? {}
		app.dataDirs = []
		app.userDirs = []
		for (const s of Object.values(doc.services ?? {})) {
			for (const v of s?.volumes ?? []) {
				// Expand first: a source like ${APP_DATA_DIR:-.}/data has a colon of its own.
				const src = typeof v === 'string' ? expandVars(v, env).split(':')[0] : v?.source && expandVars(v.source, env)
				if (!src || !/^[/.]/.test(src)) continue
				const path = resolve(appDir(app.id), src)
				// One of your folders (Videos, Music…): make sure it exists and let the app's user in.
				const mine = Object.values(USER_DIRS).map((d) => join(home, d)).find((d) => path === d || path.startsWith(`${d}/`))
				if (mine) {
					if (!(await exists(path))) await mkdir(path, {recursive: true})
					app.userDirs = [...new Set([...(app.userDirs ?? []), mine])]
					continue
				}
				// Only inside the app's own folder, or the shared folders (e.g. a Downloads subfolder).
				if (!path.startsWith(appDir(app.id)) && !path.startsWith(shared)) continue
				if (!(await exists(path))) await mkdir(path, {recursive: true})
				// Folders inside the app's own folder are its data: they get handed to its container user.
				if (path.startsWith(`${appDir(app.id)}/`) && (await stat(path).then((st) => st.isDirectory(), () => false))) app.dataDirs.push(path)
			}
		}
	}
	// Rootless containers see your files as owned by their root. Store apps mostly run as user
	// 1000 (as on the systems they were written for), so give the app's own folder to that user,
	// and let it into Downloads with an access entry (your ownership of Downloads is unchanged).
	async function prepareOwnership(app) {
		// Only the data folders: the app's compose file and manifests stay yours, so omarchyd can read them.
		const dirs = [...new Set(app.dataDirs ?? [])]
		if (dirs.length) await run('podman', ['unshare', 'chown', '-R', `${APP_UID}:${APP_UID}`, ...dirs], {env: engineEnv})
		const sub = await subordinateId()
		if (sub !== null) {
			for (const dir of new Set([join(home, 'Downloads'), ...(app.userDirs ?? [])]))
				for (const flags of [['-R', '-m'], ['-R', '-d', '-m']]) await run('setfacl', [...flags, `u:${sub + APP_UID - 1}:rwX`, dir]).catch(() => {})
		}
	}
	async function subordinateId() {
		const user = os.userInfo().username
		const line = (await readFile('/etc/subuid', 'utf8').catch(() => '')).split('\n').find((l) => l.startsWith(`${user}:`))
		const start = Number(line?.split(':')[1])
		return Number.isInteger(start) ? start : null
	}
	// App folders end up owned by container users, so remove them from inside the user namespace.
	const removeAppDir = (id) => run('podman', ['unshare', 'rm', '-rf', appDir(id)], {env: engineEnv}).catch(() => rm(appDir(id), {recursive: true, force: true}))

	// An app's exports.sh (bash from its store) sets extra variables, such as ports or derived
	// passwords. It runs in a bubblewrap sandbox: no network, read-only system, only its own app folder
	// (writable, as some keep generated passwords there), a clean environment, and a time limit. Its exported variables are returned.
	async function runExports(app) {
		const dir = appDir(app.id)
		if (!(await exists(join(dir, 'exports.sh')))) return {}
		const base = composeEnv({...app, exports: {}})
		const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address).join(' ')
		const script = [
			'derive_entropy() { printf "%s" "$1" | openssl dgst -sha256 -hmac "$OMARCHY_ENTROPY_KEY" | sed "s/^.* //"; }',
			'hostname() { case "$1" in -I|--all-ip-addresses) echo "$OMARCHY_HOST_IPS" ;; *) echo "$DEVICE_HOSTNAME" ;; esac; }',
			'app_entropy_identifier="app-${APP_ID}-seed"',
			'EXPORTS_APP_ID="$APP_ID" EXPORTS_APP_DIR="$APP_DATA_DIR" EXPORTS_TOR_DATA_DIR="$TOR_DATA_DIR"',
			'cd "$APP_DATA_DIR" && . ./exports.sh >/dev/null 2>&1',
			'unset OMARCHY_ENTROPY_KEY',
			'env -0',
		].join('\n')
		const env = {...base, OMARCHY_ENTROPY_KEY: entropyKey(), OMARCHY_HOST_IPS: ips, PATH: '/usr/bin'}
		delete env.DOCKER_HOST
		const setenv = Object.entries(env).flatMap(([k, v]) => ['--setenv', k, String(v)])
		const out = await run(
			'bwrap',
			['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64', '--ro-bind', '/etc/ssl', '/etc/ssl', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', dir, dir, '--unshare-all', '--die-with-parent', '--clearenv', ...setenv, '/usr/bin/bash', '-c', script],
			{timeout: 15_000},
		).catch(() => '')
		const result = {}
		for (const pair of out.split('\0')) {
			const i = pair.indexOf('=')
			const k = pair.slice(0, i)
			if (i > 0 && /^[A-Z][A-Z0-9_]*$/.test(k) && !(k in env) && k !== 'PWD' && k !== 'SHLVL' && k !== 'OLDPWD' && k !== '_') result[k] = pair.slice(i + 1)
		}
		return result
	}

	async function engineAvailable() {
		const ok = await run('docker-compose', ['version'], {env: engineEnv}).then(() => true, () => false)
		const sock = engineEnv.DOCKER_HOST.replace(/^unix:\/\//, '')
		return ok && (await exists(sock))
	}

	async function liveStates() {
		const out = new Map()
		await Promise.all(
			state.apps
				.filter((a) => !busy.has(a.id) && a.state !== 'error')
				.map(async (a) => {
					try {
						const text = (await compose(a, 'ps', '-a', '--format', 'json')).trim()
						const rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
						const states = rows.map((r) => String(r.State ?? r.state ?? '').toLowerCase())
						out.set(a.id, states.length && states.some((s) => s === 'running') ? 'running' : 'stopped')
					} catch {
						out.set(a.id, 'unknown')
					}
				}),
		)
		return out
	}

	// ---- procedures -----------------------------------------------------------------------------
	async function list() {
		await ready
		const live = await liveStates()
		return state.apps.map((a) => {
			const b = busy.get(a.id)
			return {
				id: a.id,
				name: a.name,
				version: a.version,
				icon: a.icon,
				port: a.port,
				internalPort: a.internalPort,
				...(a.viewPort ? {viewPort: a.viewPort} : {}),
				path: a.path ?? '',
				state: b?.state ?? (a.state === 'error' ? 'unknown' : (live.get(a.id) ?? 'unknown')),
				...(b?.progress !== undefined ? {progress: b.progress} : {}),
				...(a.state === 'error' ? {error: a.error} : {}),
				credentials: (() => {
					const password = a.deterministicPassword ? appPassword(a.id) : a.defaultPassword
					return {defaultUsername: a.defaultUsername, defaultPassword: password, showBeforeOpen: !!password}
				})(),
			}
		})
	}
	const findInstalled = (id) => {
		const a = state.apps.find((x) => x.id === id)
		if (!a) throw new RpcError('NOT_FOUND', 'That app isn’t installed')
		return a
	}

	async function ensureSharedNetwork() {
		if (await run('podman', ['network', 'exists', SHARED_NETWORK], {env: engineEnv}).then(() => true, () => false)) return
		await run('podman', ['network', 'create', '--subnet', SHARED_SUBNET, '--gateway', SHARED_GATEWAY, SHARED_NETWORK], {env: engineEnv}).catch(async (e) => {
			if (!(await run('podman', ['network', 'exists', SHARED_NETWORK], {env: engineEnv}).then(() => true, () => false))) throw e
		})
	}

	// The shared Tor proxy, as its own small container on the shared network (Alpine's tor package).
	async function ensureTor() {
		await ensureSharedNetwork()
		const dir = join(base, 'system', 'tor')
		await mkdir(join(base, 'shared-root', 'tor', 'data'), {recursive: true})
		await mkdir(dir, {recursive: true})
		const file = join(dir, 'compose.yml')
		const doc = {
			services: {
				tor: {
					image: 'docker.io/library/alpine:3.20',
					container_name: 'omarchy_tor_1',
					restart: 'unless-stopped',
					command: ['sh', '-c', `apk add --no-cache tor >/dev/null && exec tor --SocksPort 0.0.0.0:${TOR_PROXY_PORT} --ControlPort 0.0.0.0:9051 --HashedControlPassword "$$(tor --quiet --hash-password ${TOR_PASSWORD} | tail -n1)" --DataDirectory /var/lib/tor`],
					networks: {default: {ipv4_address: TOR_PROXY_IP}},
				},
			},
			networks: {default: {name: SHARED_NETWORK, external: true}},
		}
		await writeFile(file, YAML.stringify(doc), {mode: 0o600})
		await run('docker-compose', ['-p', 'omarchy-tor', '-f', file, 'up', '-d'], {env: engineEnv, cwd: dir})
	}

	async function placeApp(src, app) {
		const dir = appDir(app.id)
		await cp(src.folder, dir, {recursive: true, filter: (p) => !p.split('/').includes('.git'), force: true})
		// Its variables first: the compose file's web address and port can depend on them.
		app.exports = await runExports(app)
		const c = await readYaml(dir, COMPOSE_FILES)
		const text = await readFile(join(dir, c.name), 'utf8')
		const used = new Set(state.apps.map((a) => a.internalPort))
		const prepared = prepareCompose(app.id, text, () => {
			let p = 20_000 + (parseInt(createHash('sha256').update(app.id).digest('hex').slice(0, 4), 16) % 9000)
			while (used.has(p)) p++
			return p
		}, {shared: !!src.shared, vars: composeEnv(app), web: src.web ?? null})
		app.shared = !!src.shared
		if (app.shared) await ensureSharedNetwork()
		if (/\$\{?TOR_PROXY_IP\b/.test(text)) await ensureTor()
		// Container managers get your own (rootless) container socket, never a root one.
		let finalText = prepared.text
		if ((app.permissions ?? []).includes('containers')) {
			const sock = engineEnv.DOCKER_HOST.replace(/^unix:\/\//, '')
			const doc = YAML.parse(finalText)
			for (const svc of Object.values(doc.services ?? {}))
				svc.volumes = (svc.volumes ?? []).map((v) => (typeof v === 'string' && SOCKET.test(v.split(':')[0]) ? [sock, ...v.split(':').slice(1)].join(':') : v))
			finalText = YAML.stringify(doc)
		}
		// System ports (below 1024): only for apps you allowed; the helper lowers the limit once.
		const low = appPermissions(finalText).find((p) => p.id === 'low-ports')
		if (low && (app.permissions ?? []).includes('low-ports') && firewall?.lowPorts) await firewall.lowPorts(Math.min(...low.what.map(Number)))
		prepared.text = finalText
		await writeFile(join(dir, 'compose.omarchy.yml'), prepared.text, {mode: 0o600})
		await createBindSources(app, prepared.text)
		return prepared.internalPort
	}

	// Is `need` already covered by an installed app (itself, or one that stands in for it, such
	// as Bitcoin Knots for Bitcoin Node)?
	const satisfied = (need) => state.apps.some((a) => a.state !== 'error' && (a.id === need || (a.implements ?? []).includes(need)))

	// The extra access a listing's compose file asks for.
	async function permissionsOf(src) {
		const c = await readYaml(src.folder, COMPOSE_FILES).catch(() => null)
		return c ? appPermissions(await readFile(join(src.folder, c.name), 'utf8')) : []
	}

	// What installing `id` involves: the apps it needs that aren't installed yet, then the app.
	async function installPlan(id) {
		const src = await findInRegistry(id)
		if (!src) throw new RpcError('NOT_FOUND', 'That app isn’t in your stores')
		const plan = []
		for (const need of [...(src.needs ?? []), id]) {
			if (need !== id && satisfied(need)) continue
			const s = await findInRegistry(need)
			if (!s) throw new RpcError('NOT_FOUND', `${src.name} needs ${need}, which isn’t in your stores`)
			if (s.unsupported) throw new RpcError('PRECONDITION_FAILED', `${s.name} can’t be installed here yet. ${s.unsupported}`)
			plan.push(s)
		}
		return plan
	}

	async function install(input) {
		await ready
		const id = String(input?.appId ?? '')
		const failed = state.apps.find((a) => a.id === id && a.state === 'error')
		if (failed) {
			// A failed install: clear it away and start over.
			if (await exists(join(appDir(id), 'compose.omarchy.yml'))) await compose(failed, 'down', '--remove-orphans').catch(() => {})
			await removeAppDir(id)
			state.apps = state.apps.filter((a) => a !== failed)
			await save()
		}
		if (state.apps.some((a) => a.id === id)) throw new RpcError('CONFLICT', 'That app is already installed')
		const plan = await installPlan(id)
		// Every extra access the apps ask for must be allowed explicitly, for this install.
		const granted = new Set(Array.isArray(input?.grant) ? input.grant.map(String) : [])
		const needs = new Map()
		for (const src of plan) needs.set(src.id, (await permissionsOf(src)).map((p) => p.id))
		const missing = [...new Set([...needs.values()].flat())].filter((p) => !granted.has(p))
		if (missing.length) throw new RpcError('PRECONDITION_FAILED', `Installing needs your permission: ${missing.map((p) => PERMISSIONS[p].label.toLowerCase()).join(', ')}.`)
		if (!(await engineAvailable())) throw new RpcError('PRECONDITION_FAILED', 'Apps need Podman. Run the Omarchy Server installer again to add it.')
		// Check every port first, so nothing starts installing if one of them can't.
		const ports = new Set()
		for (const src of plan) {
			if (!src.port) continue
			if (src.port < 1024 || src.port > 65535 || RESERVED(src.port)) throw new RpcError('PRECONDITION_FAILED', `${src.name} wants port ${src.port}, which Omarchy Server keeps for itself`)
			if (ports.has(src.port) || state.apps.some((a) => a.port === src.port) || !(await portFree(src.port))) throw new RpcError('CONFLICT', `Port ${src.port} is already in use, so ${src.name} can’t be installed`)
			ports.add(src.port)
		}
		// Every app in the plan shows as installing right away; they then install one after another.
		const queued = plan.map((src) => {
			const leftover = state.apps.find((a) => a.id === src.id && a.state === 'error')
			if (leftover) state.apps = state.apps.filter((a) => a !== leftover)
			const app = {id: src.id, name: src.name, version: src.version, icon: src.icon, port: src.port, path: src.path, defaultUsername: src.defaultUsername, defaultPassword: src.defaultPassword, deterministicPassword: src.deterministicPassword, ...(src.openPorts?.length ? {openPorts: src.openPorts} : {}), ...(src.store ? {store: src.store} : {}), ...(src.implements?.length ? {implements: src.implements} : {}), installedAt: Date.now(), state: 'installing', permissions: needs.get(src.id) ?? []}
			state.apps.push(app)
			busy.set(app.id, {state: 'installing', progress: 0})
			return {src, app}
		})
		await save()
		;(async () => {
			let broken = null
			for (const {src, app} of queued) {
				if (broken) {
					Object.assign(app, {state: 'error', error: `Couldn’t install ${broken}, which this app needs.`})
					busy.delete(app.id)
					continue
				}
				busy.set(app.id, {state: 'installing', progress: 5})
				try {
					await sharedRoot()
					app.internalPort = await placeApp(src, app)
					await prepareOwnership(app)
					busy.set(app.id, {state: 'installing', progress: 15})
					await compose(app, 'pull')
					busy.set(app.id, {state: 'installing', progress: 85})
					await compose(app, 'up', '-d', '--remove-orphans')
					await openGateways(app)
					delete app.state
					delete app.error
				} catch (error) {
					Object.assign(app, {state: 'error', error: error.message})
					broken = app.name
				} finally {
					busy.delete(app.id)
					await save().catch(() => {})
				}
			}
		})()
		return true
	}

	async function update(input) {
		await ready
		const app = findInstalled(String(input?.appId ?? ''))
		const src = await findInRegistry(app.id)
		if (!src) throw new RpcError('NOT_FOUND', 'That app is no longer in your stores')
		// An update never adds access you didn't allow. (Apps installed before permissions existed keep what they run with.)
		const wants = (await permissionsOf(src)).map((p) => p.id)
		app.permissions ??= wants
		const extra = wants.filter((p) => !app.permissions.includes(p) && !(Array.isArray(input?.grant) && input.grant.includes(p)))
		if (extra.length) throw new RpcError('PRECONDITION_FAILED', `This update asks for more access (${extra.map((p) => PERMISSIONS[p].label.toLowerCase()).join(', ')}). Uninstall and install it again to allow that.`)
		app.permissions = [...new Set([...app.permissions, ...wants])]
		busy.set(app.id, {state: 'updating', progress: 10})
		try {
			app.internalPort = await placeApp(src, app)
			closeGateway(app.id)
			await compose(app, 'pull')
			await compose(app, 'up', '-d', '--remove-orphans')
			Object.assign(app, {version: src.version, name: src.name, icon: src.icon, path: src.path})
			await openGateways(app)
			delete app.state
			delete app.error
		} finally {
			busy.delete(app.id)
			await save()
		}
		return true
	}

	const lifecycle = (args, pending) => async (input) => {
		await ready
		const app = findInstalled(String(input?.appId ?? ''))
		if (busy.has(app.id)) throw new RpcError('CONFLICT', `${app.name} is busy`)
		busy.set(app.id, {state: pending})
		try {
			await compose(app, ...args)
		} finally {
			busy.delete(app.id)
		}
		return true
	}

	async function uninstall(input) {
		await ready
		const app = findInstalled(String(input?.appId ?? ''))
		// Keep apps that other installed apps rely on (unless another app stands in for it).
		const provides = [app.id, ...(app.implements ?? [])]
		const users = []
		for (const other of state.apps) {
			if (other.id === app.id) continue
			const src = await findInRegistry(other.id).catch(() => null)
			const needs = (src?.needs ?? []).filter((n) => provides.includes(n))
			if (needs.some((n) => !state.apps.some((a) => a.id !== app.id && a.state !== 'error' && (a.id === n || (a.implements ?? []).includes(n))))) users.push(other.name ?? other.id)
		}
		if (users.length) throw new RpcError('PRECONDITION_FAILED', `${users.join(', ')} ${users.length > 1 ? 'need' : 'needs'} ${app.name ?? app.id}. Uninstall ${users.length > 1 ? 'them' : 'it'} first.`)
		busy.set(app.id, {state: 'uninstalling'})
		try {
			closeGateway(app.id)
			if (app.port) await firewall?.close(app.port)
			if (app.viewPort) await firewall?.close(app.viewPort)
			for (const p of app.openPorts ?? []) await firewall?.close(p)
			if (await exists(join(appDir(app.id), 'compose.omarchy.yml'))) await compose(app, 'down', '--volumes', '--remove-orphans').catch(() => {})
			await removeAppDir(app.id)
			state.apps = state.apps.filter((a) => a.id !== app.id)
			state.recent = state.recent.filter((r) => r !== app.id)
			await save()
		} finally {
			busy.delete(app.id)
		}
		return true
	}

	async function updates() {
		const out = []
		for (const a of state.apps) {
			const src = await findInRegistry(a.id).catch(() => null)
			if (src?.version && a.version && src.version !== a.version) out.push({id: a.id, version: src.version})
		}
		return out
	}

	// A shell inside an installed app's main container (the one the gateway forwards to).
	async function shellFor(appId) {
		await ready
		const app = findInstalled(String(appId))
		const doc = YAML.parse(await readFile(join(appDir(app.id), 'compose.omarchy.yml'), 'utf8')) ?? {}
		const names = Object.keys(doc.services ?? {})
		const main = names.find((n) => (doc.services[n].ports ?? []).some((p) => String(p).startsWith(`127.0.0.1:${app.internalPort}:`))) ?? names[0]
		if (!main) throw new RpcError('NOT_FOUND', 'That app has no containers')
		return {
			command: ['docker-compose', '-p', project(app.id), '-f', join(appDir(app.id), 'compose.omarchy.yml'), 'exec', main, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
			env: {...process.env, ...composeEnv(app)},
			cwd: appDir(app.id),
		}
	}

	return {
		ready,
		shellFor,
		checkSession,
		issueSession,
		sessionCookie,
		// End every app pass this person holds (signing out their other devices). Returns a new one.
		async revokePasses(userId) {
			state.passGen = {...(state.passGen ?? {}), [userId]: (state.passGen?.[userId] ?? 0) + 1}
			await save()
			return issueSession(userId)
		},
		// Factory reset: uninstall every app (apps others need go last).
		async uninstallAll() {
			for (let round = 0; round < 20 && state.apps.length; round++) {
				const before = state.apps.length
				for (const a of [...state.apps]) await uninstall({appId: a.id}).catch(() => {})
				if (state.apps.length === before) break
			}
			state.passGen = {}
			await save()
			return state.apps.length
		},
		close: () => {
			for (const id of [...gateways.keys()]) closeGateway(id)
		},
		procedures: {
			'apps.list': {kind: 'query', run: list},
			'apps.install': {kind: 'mutation', run: install},
			'apps.installReview': {
				kind: 'query',
				run: async (input) => {
					const plan = await installPlan(String(input?.appId ?? '')).catch(() => [])
					const also = plan.slice(0, -1).map((a) => ({id: a.id, name: a.name, icon: a.icon}))
					// Extra access, per app in the plan (shown for you to allow before installing).
					const access = []
					for (const a of plan) for (const p of await permissionsOf(a)) access.push({...p, appId: a.id, appName: a.name})
					return {requiredFolders: [], gpuAccess: false, alsoInstalls: also, permissions: access}
				},
			},
			'apps.uninstall': {kind: 'mutation', run: uninstall},
			'apps.start': {kind: 'mutation', run: lifecycle(['up', '-d'], 'starting')},
			'apps.stop': {kind: 'mutation', run: lifecycle(['stop'], 'stopping')},
			'apps.restart': {kind: 'mutation', run: lifecycle(['restart'], 'restarting')},
			'apps.update': {kind: 'mutation', run: update},
			'apps.updates': {kind: 'query', run: updates},
			'apps.logs': {
				kind: 'query',
				run: async (input) => {
					const app = findInstalled(String(input?.appId ?? ''))
					const text = await compose(app, 'logs', '--no-color', '--tail', '500')
					const max = Math.min(Number(input?.maxOutputBytes) || 200_000, 1_000_000)
					return text.length > max ? text.slice(-max) : text
				},
			},
			'apps.trackOpen': {
				kind: 'mutation',
				run: async (input) => {
					const id = String(input?.appId ?? '')
					if (!state.apps.some((a) => a.id === id)) return true
					state.recent = [id, ...state.recent.filter((r) => r !== id)].slice(0, 12)
					await save()
					return true
				},
			},
			'apps.recentlyOpened': {kind: 'query', run: async () => (await ready, state.recent.filter((id) => state.apps.some((a) => a.id === id)))},
			// A one-time hand-over for a browser that opens an app before it has an app session.
			// Does the app answer behind its gateway? Used when its window is slow, to say why.
			'apps.probe': {
				kind: 'query',
				run: async (input) => {
					const app = findInstalled(String(input?.appId ?? ''))
					const target = app.internalPort ?? app.port
					if (!target) return {result: 'no-web'}
					return await new Promise((resolve) => {
						const req = http.request({host: '127.0.0.1', port: target, path: app.path || '/', method: 'GET', timeout: 6000, headers: {accept: 'text/html'}}, (r) => {
							r.resume()
							resolve({result: 'answered', status: r.statusCode, location: r.headers.location ?? null, gateway: gateways.has(app.id) || gateways.has(gatewayKey(app.id, true))})
						})
						req.on('timeout', () => (req.destroy(), resolve({result: 'timeout'})))
						req.on('error', (e) => resolve({result: e.code === 'ECONNREFUSED' ? 'refused' : 'error', error: e.code ?? e.message}))
						req.end()
					})
				},
			},
			'apps.accessTicket': {
				kind: 'mutation',
				run: async (input, {auth}) => {
					const app = findInstalled(String(input?.appId ?? ''))
					const t = randomBytes(24).toString('base64url')
					for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k)
					tickets.set(t, {appId: app.id, userId: auth.userId, exp: Date.now() + 60_000})
					// The view gateway's port when asked for it (or when the app has no gateway of its own).
					const port = app.viewPort && (input?.view || !app.internalPort) ? app.viewPort : app.port
					return {ticket: t, port, path: app.path ?? ''}
				},
			},
			'appStore.registry': {kind: 'query', run: async () => (await registry()).map(({url, meta, apps}) => ({url, meta, apps: apps.map(({folder, ...a}) => a)}))},
			'appStore.repositories': {kind: 'query', run: async () => (await ready, state.stores.map(({url, meta, name}) => ({url, meta: meta ?? {id: url, name: name ?? url.split('/').pop()}})))},
			'appStore.addRepository': {
				kind: 'mutation',
				run: async (input) => {
					await ready
					const url = normalize(input?.url)
					checkUrl(url)
					if (state.stores.some((s) => s.url.toLowerCase() === url.toLowerCase())) throw new RpcError('CONFLICT', 'That store is already added')
					try {
						await rm(storeDir(url), {recursive: true, force: true})
						await syncStore(url)
					} catch {
						await rm(storeDir(url), {recursive: true, force: true})
						throw new RpcError('BAD_REQUEST', 'Couldn’t download that store. Check the address and that the repository is public.')
					}
					let loaded
					try {
						loaded = await loadStore(url)
					} catch (e) {
						await rm(storeDir(url), {recursive: true, force: true})
						throw e
					}
					state.stores.push({url, meta: loaded.meta, syncedAt: Date.now()})
					registryCache = null
					await save()
					return true
				},
			},
			'appStore.removeRepository': {
				kind: 'mutation',
				run: async (input) => {
					await ready
					const url = normalize(input?.url)
					const s = state.stores.find((x) => x.url.toLowerCase() === url.toLowerCase())
					if (!s) throw new RpcError('NOT_FOUND', 'That store isn’t added')
					state.stores = state.stores.filter((x) => x !== s)
					await rm(storeDir(s.url), {recursive: true, force: true})
					registryCache = null
					await save()
					return true
				},
			},
		},
	}
}
