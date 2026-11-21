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
import {writeAtomic} from './atomic.mjs'
import {execFile} from 'node:child_process'
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto'
import {lstatSync, readlinkSync, realpathSync} from 'node:fs'
import {access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import tls from 'node:tls'
import YAML from 'yaml'

import {createKeyedLock} from './locks.mjs'
import {RpcError, handleRpc, sendError} from './rpc.mjs'
import {SYSTEM_PERMISSIONS} from './system-apps.mjs'
import {dualProtocolServer, tlsContext, wantsUpgrade} from './tls.mjs'
import {linkProxy} from './proxy-link.mjs'
import {usbComposeOverlay} from './usb.mjs'

export const APP_COOKIE = 'OMARCHY_APP_SESSION'
// Every cookie Omarchy Server itself sets (and any it may set later under these prefixes).
export const OWN_COOKIE = /^(omarchy_server_|OMARCHY_)/i
const STORE_FILES = ['omarchy-app-store.yml', 'umbrel-app-store.yml']
const APP_FILES = ['omarchy-app.yml', 'umbrel-app.yml']
const COMPOSE_FILES = ['omarchy-compose.yml', 'docker-compose.yml']
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const RESERVED = (p) => p === 7780 || p === 2021 || (p >= 40_000 && p <= 49_999)
function bumpPort(start, avoid) {
	let p = start
	for (let i = 0; i < 65535; i++) {
		if (p >= 1 && p <= 65535 && !avoid.has(p)) return p
		p = p >= 65535 ? 1 : p + 1
	}
	return null
}
function nextHostPort(start, avoid) {
	let p = start
	for (let i = 0; i < 65535; i++) {
		p = p >= 65535 ? 1024 : p + 1
		if (p >= 1024 && !RESERVED(p) && !avoid.has(p)) return p
		if (p === start) break
	}
	return null
}
const SESSION_DAYS = 30
// Some stores keep icons and screenshots in a separate gallery site, by app id.
// Stores every new Omarchy Server starts with (you can remove them under App Store → Stores). They're
// downloaded from GitHub by your server; nothing from them is copied into Omarchy Server itself.
// TouchWorkStation's own catalog: plain Docker Compose files from each project's official image, with
// original descriptions. Other stores (including Umbrel-format ones) can still be added by hand.
export const DEFAULT_STORES = [{url: 'https://github.com/TouchWorkStation/app-store'}]
export const isGithubAppStore = (url) => /github\.com\/touchworkstation\/app-store(\.git)?$/i.test(String(url ?? '').replace(/\/+$/, ''))
const GALLERIES = {}
// Variables omarchyd provides to every app (anything else a compose file needs without a default
// means the app relies on something Omarchy Server doesn't offer yet).
const PROVIDED = new Set(['APP_DATA_DIR', 'APP_DATA_ROOT', 'APP_ID', 'APP_DOMAIN', 'APP_VERSION', 'APP_PROXY_PORT', 'APP_HIDDEN_SERVICE', 'GATEWAY_IP', 'DEVICE_HOSTNAME', 'DEVICE_DOMAIN_NAME', 'APP_PASSWORD', 'APP_SEED', 'APP_SEED_32', 'UMBREL_ROOT', 'DOCKER_HOST', 'TZ', 'NETWORK_IP', 'TOR_PROXY_IP', 'TOR_PROXY_PORT', 'TOR_DATA_DIR', 'TOR_PASSWORD', 'SERVER_IP', 'HOME', 'DOWNLOADS_DIR', 'VIDEOS_DIR', 'MUSIC_DIR', 'PICTURES_DIR', 'DOCUMENTS_DIR', 'PUID', 'PGID', 'DOCKER_SOCKET', 'APP_GATEWAY_KEY'])
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
// Where apps that are part of the server itself (system-apps.mjs) are listed.
const BUILTIN_STORE = 'builtin:omarchy-server'
// Apps brought over by the Unraid importer (unraid.mjs): listings it writes on this server, never
// fetched from anywhere, so they're listed and installed like any store's.
const IMPORTED_STORE = 'local:imported'
// Apps published by another app on this server (a studio). Same idea: a folder of listings, not a
// git clone, so a refresh can't wipe what was just published.
const PUBLISHED_STORE = 'local:published'
// The tool mounted into an app that is allowed to publish. It talks to a Unix socket that serves
// only apps.publish and apps.unpublish, never the Podman socket and never the rest of omarchyd.
const PUBLISH_CLI = fileURLToPath(new URL('./omarchy-publish', import.meta.url))
const API_PROXY = fileURLToPath(new URL('./api-proxy', import.meta.url))
const BIND_SHIM = fileURLToPath(new URL('./bind-localhost.c', import.meta.url))
const PUBLISH_RPC = new Set(['/trpc/apps.publish', '/trpc/apps.unpublish'])
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]{0,200}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,40})?$/
// The binary is not the container's entrypoint. A proxy in front of it demands the job API
// token, and the sign-in gateway's own header on the web port. The image is Omarchy, the same
// system the studio compiles on, so the binary's glibc matches. gcc builds the localhost shim
// and is removed; gcc-libs stays because the binary links it.
const OMARCHY_SETUP = fileURLToPath(new URL('./omarchy-setup.sh', import.meta.url))
const runtimeContainerfile = ({webPort, apiPort, childPort, assets}) => `FROM docker.io/archlinux:base
COPY omarchy-setup.sh /tmp/omarchy-setup.sh
RUN sh /tmp/omarchy-setup.sh && rm /tmp/omarchy-setup.sh
COPY app /usr/local/bin/app
COPY api-proxy /usr/local/bin/api-proxy
COPY bind-localhost.c /tmp/bind-localhost.c
${assets ? 'COPY static /opt/app/static\n' : ''}RUN gcc -shared -fPIC -Os -o /usr/local/lib/omarchy-bind-localhost.so /tmp/bind-localhost.c -ldl \\
 && rm /tmp/bind-localhost.c \\
 && chmod 755 /usr/local/bin/app /usr/local/bin/api-proxy \\
 && pacman -R --noconfirm gcc \\
 && rm -rf /var/cache/pacman/pkg/*
ENV WEB_PORT=${webPort} API_PORT=${apiPort} CHILD_PORT=${childPort} OMARCHY_APP_CWD=/opt/app
WORKDIR /opt/app
ENTRYPOINT ["/usr/local/bin/api-proxy"]
`

export const PERMISSIONS = {
	containers: {label: 'Control your containers', detail: 'It can start, stop, create and delete every container you run (and see their settings and data). Container managers need this.'},
	'low-ports': {label: 'Use network ports below 1024', detail: 'It listens on system ports such as 53 (DNS), 80 or 443. To allow it, Omarchy Server lets programs running as you use ports from that number up, for the whole server, and keeps that after this app is removed.'},
	devices: {label: 'Use hardware devices', detail: 'It gets direct access to devices plugged into your server, such as USB sticks or video cards.'},
	network: {label: 'Change networking inside its container', detail: 'It can create network interfaces, routes and firewall rules inside its own container (VPNs need this). It can’t change your server’s own network.'},
	privileged: {label: 'Run with every container permission', detail: 'It runs with all permissions inside its container. Containers here run as you, not as root, so it still can’t become root on your server.'},
	'host-network': {label: 'Share the server’s own network', detail: 'It uses the server’s network directly instead of its own: it can reach services that listen only on this server, and other devices see it as the server. Home Assistant and similar apps need this to find devices.'},
	'host-files': {label: 'Read and change folders on the server', detail: 'It can read and change these folders on your server, with your rights (containers here run as you).'},
	publish: {label: 'Publish apps on this server', detail: 'It can add, update, and remove apps it publishes here. It cannot control your other containers, and it cannot change the rest of the server.'},
	system: {label: 'Reach into the server’s system', detail: 'It can see or talk to parts of the server outside its container (other programs, system services or kernel features). Monitoring tools and smart-home hubs sometimes need this.'},
	...SYSTEM_PERMISSIONS,
}
// Bind mounts no app may have, whatever it asks: your whole home folder, its hidden folders (SSH keys,
// settings, Omarchy Server's own data and keys), and the system's own folders.
// An app's own data is under ~/.local too. createBindSources still claims that one folder.
const under = (p, base) => Boolean(base) && (p === base || p.startsWith(`${base}/`))
const CLOCK_FILES = ['/etc/localtime', '/etc/timezone']
// `home` may itself be a symlink. A path under the link or under its target is still inside home.
function homeBases(home) {
	if (typeof home !== 'string' || !home.startsWith('/')) return []
	const base = resolve(home).replace(/\/+$/, '')
	const bases = [base]
	try {
		const real = realpathSync(base)
		if (real && real !== base) bases.push(real)
	} catch {
		/* home is not there yet */
	}
	return bases
}
function refusedMount(path, home) {
	const bases = homeBases(home)
	if (path === '/' || bases.includes(path) || path === '/home' || under(path, '/root') || under(path, '/boot') || under(path, '/proc') || under(path, '/run/user') || under(path, '/var/lib') || under(path, '/usr') || under(path, '/bin') || under(path, '/sbin')) return true
	if (under(path, '/etc') && !CLOCK_FILES.includes(path)) return true
	if (bases.some((b) => path.startsWith(`${b}/.`))) return true
	if (/^\/home\/[^/]+$/.test(path) || (path.startsWith('/home/') && bases.length && !bases.some((b) => under(path, b)))) return true
	return false
}
const SOCKET = /(?:^|\/)(?:docker|podman)\.sock$|\$\{?DOCKER_SOCKET/
const SYSTEM_PATH = /^\/run\/(dbus|systemd|udev)(\/|$)|^\/var\/run\/dbus(\/|$)|^\/(sys|lib\/modules|usr\/lib\/modules)(\/|$)/
// Follow the longest prefix that exists, the way the folder picker does, so a symlink under an
// allowed folder can't hide a refused one. Missing paths stay as resolved (Compose will create them).
// lstat, not exists: a dangling symlink is the folder it names, not "missing so use the parent".
// Only absolute paths: a leftover `$VAR` must not walk dirname to `.` and glue onto the process cwd.
function realpathExisting(path, seen) {
	if (!path || path.includes('\0') || !path.startsWith('/')) return path
	seen ??= new Set()
	if (seen.has(path) || seen.size > 32) return path
	seen.add(path)
	let st
	try {
		st = lstatSync(path)
	} catch {
		st = null
	}
	if (st?.isSymbolicLink()) {
		let dest = ''
		try {
			dest = readlinkSync(path)
		} catch {
			return path
		}
		const abs = dest.startsWith('/') ? dest : resolve(dirname(path), dest)
		return realpathExisting(resolve(abs), seen)
	}
	if (st) {
		try {
			return realpathSync(path)
		} catch {
			return path
		}
	}
	const parent = dirname(path)
	if (parent === path) return path
	const realParent = realpathExisting(parent, seen)
	return realParent === parent ? path : realParent + path.slice(parent.length)
}
// KEY=value lines Compose reads from a listing's .env (shell env still wins).
function parseDotEnv(text) {
	const env = {}
	for (const line of String(text).split('\n')) {
		const t = line.trim()
		if (!t || t.startsWith('#')) continue
		const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
		if (!m) continue
		let v = m[2]
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
		else {
			const cut = v.search(/\s+#/)
			if (cut >= 0) v = v.slice(0, cut).trimEnd()
		}
		env[m[1]] = v
	}
	return env
}
// Compose interpolates ${VAR} inside .env values from earlier keys and the process environment.
function expandDotEnv(dotenv, overlay = {}) {
	const out = {}
	for (const [k, v] of Object.entries(dotenv ?? {})) out[k] = expandVars(String(v), {...dotenv, ...out, ...overlay})
	return out
}
// The host folder a bind will actually use: expand is already done; collapse `..`, turn `~` and
// leftover $HOME into the home folder Compose will see, and resolve relative sources from the app.
function bindHostPath(raw, where = {}) {
	let path = String(raw ?? '')
	if (!path || path.includes('\0')) return path
	const home = where.home
	if (home) {
		if (path === '~' || path.startsWith('~/')) path = `${home}${path.slice(1)}`
		else if (path === '${HOME}' || path.startsWith('${HOME}/')) path = `${home}${path.slice('${HOME}'.length)}`
		else if (path === '$HOME' || path.startsWith('$HOME/')) path = `${home}${path.slice('$HOME'.length)}`
	}
	const cwd = where.cwd ?? where.allowed?.[0]
	if (path.startsWith('/')) path = resolve(path)
	else if (cwd && !path.startsWith('$')) path = resolve(cwd, path)
	return path.replace(/\/+$/, '') || '/'
}
// What a compose file asks of the server beyond an ordinary container. `where` (when known) says
// which folders are the app's own: its data folder, the shared folders and your media folders
// (Videos, Music…), which apps may use without asking; `expand` resolves its variables.
export function appPermissions(text, where = {}) {
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
		if (s.network_mode === 'host') add('host-network', name)
		for (const k of ['pid', 'ipc', 'uts', 'cgroup']) if (s[k] === 'host') add('system', `${k}: host`)
		for (const o of s.security_opt ?? []) add('system', `security_opt: ${o}`)
		for (const v of s.volumes ?? []) {
			const type = typeof v === 'object' ? v?.type : null
			if (type === 'volume' || type === 'tmpfs') continue
			// A bare "/path" is an anonymous volume (inside the container), not a server folder.
			if (typeof v === 'string' && !v.includes(':')) continue
			const orig = typeof v === 'string' ? v.trim() : String(v?.source ?? '').trim()
			const raw = typeof v === 'string' ? (where.expand ? where.expand(v) : v).split(':')[0] : String(where.expand ? where.expand(v?.source ?? '') : (v?.source ?? ''))
			const looksBind = type === 'bind' || raw.startsWith('/') || raw.startsWith('$') || raw.startsWith('~') || raw.startsWith('.') || raw.includes('/') || (!raw && (type === 'bind' || orig.startsWith('$') || orig.startsWith('~') || orig.startsWith('/') || orig.startsWith('.')))
			if (SOCKET.test(raw)) add('containers', name)
			else if (looksBind) {
				// Host paths (after expanding): resolve `..` and `~` the way Compose will, so an allowed
				// prefix can't hide a hidden folder. Long-syntax `type: bind` and relative sources
				// with a slash are binds too. Classify the real path (devices, system, own, refused).
				const path = bindHostPath(raw, where)
				if (!path || path.includes('\0') || path.startsWith('$')) {
					add('refused', 'invalid path')
					continue
				}
				// /etc/localtime is often a link into /usr/share/zoneinfo; allow the bind, don't follow it.
				if (CLOCK_FILES.includes(path)) continue
				const real = realpathExisting(path)
				if (SOCKET.test(path) || SOCKET.test(real)) add('containers', name)
				else if (/^\/dev(\/|$)/.test(real) && !/^\/dev\/shm/.test(real)) add('devices', real)
				// System folders, as written or as resolved: on Arch (and so Omarchy) /lib is a link to
				// /usr/lib, so /lib/modules resolves under /usr and must still count as a system folder.
				else if (SYSTEM_PATH.test(path) || SYSTEM_PATH.test(real)) add('system', SYSTEM_PATH.test(path) ? path : real)
				else {
					const own = (where.allowed ?? []).some((d) => {
						if (!d) return false
						const base = realpathExisting(d)
						return under(real, base) || under(real, d)
					})
					if (own) continue
					if (refusedMount(real, where.home) || refusedMount(path, where.home)) add('refused', real)
					else add('host-files', real)
				}
			}
		}
		for (const d of s.devices ?? []) add('devices', String(typeof d === 'string' ? d.split(':')[0] : d?.source ?? 'device'))
		for (const c of s.cap_add ?? []) {
			const cap = String(c).toUpperCase().replace(/^CAP_/, '')
			if (/^(SYS_ADMIN|ALL)$/.test(cap)) add('privileged', cap)
			else if (/^(NET_ADMIN|NET_RAW|SYS_MODULE)$/.test(cap)) add('network', cap)
			// Ordinary ones (file ownership, binding ports, signals) stay inside the container.
			else if (!/^(CHOWN|DAC_OVERRIDE|FOWNER|FSETID|SETUID|SETGID|SETPCAP|NET_BIND_SERVICE|KILL|AUDIT_WRITE|MKNOD|SETFCAP|SYS_CHROOT|SYS_NICE|SYS_RESOURCE|IPC_LOCK)$/.test(cap)) add('system', cap)
		}
		if (s.sysctls && Object.keys(s.sysctls).length) add('network', 'sysctls')
		// Long syntax publishes the host port as one value (not host:container). Install calls this
		// with no `where`, so a default such as ${PORT:-80} still has to expand. A start-end range
		// counts from its low end. One part, or only `target`, is the container port.
		const expandPort = (v) => (where.expand ? where.expand(v) : expandVars(String(v), {}))
		for (const p of s.ports ?? []) {
			const long = !!p && typeof p === 'object'
			const spec = expandPort(long ? String(p.published ?? '') : String(p).split('/')[0])
			const parts = long ? null : spec.split(':')
			const hostPort = long ? spec : parts.length >= 3 ? parts[parts.length - 2] : parts.length === 2 ? parts[0] : ''
			const host = Number(String(hostPort).split('-')[0])
			if (Number.isInteger(host) && host > 0 && host < 1024) add('low-ports', host)
		}
	}
	return [...found].map(([id, set]) => ({id, ...(PERMISSIONS[id] ?? {label: 'Not allowed', detail: 'Omarchy Server never gives an app these folders.'}), what: [...set].slice(0, 8)}))
}

// Compose-style ${NAME}, $NAME, ${NAME:-default}, ${NAME-default} and ${NAME:?message}.
// The default may itself contain ${...}; a scan to the first } would stop too early.
export function expandVars(text, env) {
	const s = String(text)
	let out = ''
	for (let i = 0; i < s.length; i++) {
		if (s[i] !== '$') {
			out += s[i]
			continue
		}
		const braced = s[i + 1] === '{'
		const nameAt = braced ? i + 2 : i + 1
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(nameAt))
		if (!name) {
			out += '$'
			continue
		}
		let j = nameAt + name[0].length
		let colon = false
		let op = ''
		let arg = ''
		if (braced) {
			if (s[j] === ':') {
				colon = true
				j++
			}
			if (s[j] === '-' || s[j] === '+' || s[j] === '?') {
				op = s[j++]
				const start = j
				let depth = 0
				while (j < s.length) {
					if (s[j] === '$' && s[j + 1] === '{') {
						depth++
						j += 2
						continue
					}
					if (s[j] === '}') {
						if (depth === 0) break
						depth--
					}
					j++
				}
				if (s[j] !== '}') {
					out += '$'
					continue
				}
				arg = s.slice(start, j)
			} else if (s[j] !== '}') {
				out += '$'
				continue
			}
		}
		const v = env[name[0]]
		const empty = v === undefined || (colon && v === '')
		const repl = op === '-' ? (empty ? expandVars(arg, env) : v) : op === '+' ? (empty ? '' : expandVars(arg, env)) : (v ?? '')
		out += repl
		i = braced ? j : j - 1
	}
	return out
}

// Folders an app lets you place yourself (its listing's `folders:`): kept inside the app, or a folder
// of yours under your home that you pick when installing. The compose file uses ${FOLDER_<ID>}.
export function folderChoices(list) {
	if (!Array.isArray(list)) return []
	return list
		.filter((f) => f && typeof f.id === 'string' && /^[a-z][a-z0-9_]{0,30}$/.test(f.id))
		.slice(0, 4)
		.map((f) => ({
			id: f.id,
			label: String(f.label ?? f.id).slice(0, 80),
			detail: typeof f.detail === 'string' ? f.detail.slice(0, 400) : '',
			// A suggested folder name under your home (one plain name, no paths).
			suggest: typeof f.suggest === 'string' && /^[A-Za-z0-9][\w .-]{0,60}$/.test(f.suggest) ? f.suggest : null,
		}))
}

// Optional catalog MCP endpoint. Junk is ignored; the port is never opened to the network.
export function parseMcp(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const service = raw.service
	const port = typeof raw.port === 'string' && raw.port.trim() ? Number(raw.port) : raw.port
	const path = raw.path
	const transport = raw.transport
	if (typeof service !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(service)) return null
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
	if (typeof path !== 'string' || !/^\/[^\s?#]{0,200}$/.test(path)) return null
	if (transport !== 'http' && transport !== 'sse') return null
	return {service, port, path, transport}
}
export const folderVar = (id) => `FOLDER_${id.toUpperCase()}`
// Where you may put an app's folder: under your home, not hidden, not one Omarchy Server never gives an app.
export function folderAllowed(path, home) {
	if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return false
	const p = resolve(path)
	if (p !== path.replace(/\/+$/, '')) return false
	const root = homeBases(home).find((b) => p.startsWith(`${b}/`))
	if (!root) return false
	if (p.slice(root.length).split('/').some((part) => part.startsWith('.'))) return false
	return !refusedMount(p, home)
}

export function missingVars(text, alsoProvided = []) {
	const out = new Set()
	for (const m of String(text).replace(/\$\$/g, '').matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
		const name = m[1] ?? m[3]
		const rest = m[2] ?? ''
		if (/^:?[-=]/.test(rest)) continue // has a default
		if (!PROVIDED.has(name) && !alsoProvided.includes(name) && !/^FOLDER_[A-Z0-9_]+$/.test(name)) out.add(name)
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
const LOAD_CONCURRENCY = 16

async function mapPool(items, n, fn) {
	const out = new Array(items.length)
	let i = 0
	await Promise.all(
		Array.from({length: Math.min(n, items.length)}, async () => {
			while (i < items.length) {
				const idx = i++
				out[idx] = await fn(items[idx], idx)
			}
		}),
	)
	return out
}
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

async function readFirst(dir, names) {
	for (const n of names) {
		try {
			return {name: n, text: await readFile(join(dir, n), 'utf8')}
		} catch (e) {
			if (e.code !== 'ENOENT') throw e
		}
	}
	return null
}

// Public listing fields. Pick these by name so a later loadStore change cannot leak folder, store, or compose.
const LIST_FIELDS = [
	'id', 'name', 'tagline', 'icon', 'category', 'version', 'developer', 'unsupported', 'caution',
	'needs', 'dependencies', 'implements', 'port', 'path', 'web', 'shared', 'folders', 'openPorts',
	'requiresHttps', 'system', 'defaultUsername', 'defaultPassword', 'deterministicPassword', 'repo',
]
const DETAIL_FIELDS = [...LIST_FIELDS, 'description', 'releaseNotes', 'gallery', 'website', 'permissions']

function pickFields(a, keys) {
	const out = {}
	for (const k of keys) if (a[k] !== undefined) out[k] = a[k]
	return out
}

// Browse payload: keep a shots count so Featured can pick apps that have screenshots.
function toList(a) {
	return {...pickFields(a, LIST_FIELDS), ...(Array.isArray(a.gallery) && a.gallery.length ? {shots: a.gallery.length} : {})}
}

function toDetail(a) {
	return pickFields(a, DETAIL_FIELDS)
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
// A number round-trip drops digits past 2^53 and leading zeros. Compose reads 0400 as octal.
class KeptSource {
	constructor(source) {
		this.source = source
	}
}
function emitCompose(doc) {
	YAML.visit(doc, {
		Scalar(_key, node) {
			if (typeof node.source === 'string' && (typeof node.value === 'number' || typeof node.value === 'bigint')) node.value = new KeptSource(node.source)
		},
	})
	const schema = doc.schema.clone()
	schema.tags.unshift({
		identify: (value) => value instanceof KeptSource,
		default: true,
		tag: 'tag:yaml.org,2002:str',
		stringify: (node) => node.value.source,
	})
	doc.schema = schema
	return doc.toString({lineWidth: 0})
}
const pairKey = (pair) => (YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key))
const asJSON = (item) => (item && typeof item.toJSON === 'function' ? item.toJSON() : item)
function appendPort(svc, spec) {
	const ports = svc.get('ports')
	// Seq.add stores the value as-is. A bare string has no toJSON, so later filters throw.
	if (YAML.isSeq(ports)) ports.items.push(new YAML.Scalar(spec))
	else if (ports == null) svc.set('ports', [spec])
	else if (Array.isArray(ports)) svc.set('ports', [...ports, spec])
	else svc.set('ports', [...(typeof ports === 'string' ? [...ports] : [ports]), spec])
}
function retainPorts(svc, keep) {
	const ports = svc.get('ports')
	if (YAML.isSeq(ports)) ports.items = ports.items.filter((item) => keep(asJSON(item)))
	else if (Array.isArray(ports)) svc.set('ports', ports.filter((item) => keep(asJSON(item))))
}
export function prepareCompose(appId, text, allocatePort, {shared = false, vars = {}, web = null, mcp = null} = {}) {
	const doc = YAML.parseDocument(String(text ?? ''))
	if (doc.errors.length) throw doc.errors[0]
	if (!doc.contents) doc.contents = doc.createNode({})
	if (!YAML.isMap(doc.contents)) throw new Error('Compose file must be a mapping')
	if (!YAML.isMap(doc.get('services'))) doc.set('services', {})
	const serviceNodes = doc.get('services')
	const proxyNode = serviceNodes.get('app_proxy')
	const envNode = YAML.isMap(proxyNode) ? proxyNode.get('environment') : null
	const proxy = YAML.isMap(envNode) ? (envNode.toJSON() ?? {}) : {}
	serviceNodes.delete('app_proxy')
	doc.delete('version')
	for (const pair of serviceNodes.items) {
		const s = pair.value
		if (!YAML.isMap(s)) continue
		// Podman ignores userns_mode (UsernsMode stays private). Leave it out of the file that
		// runs, and say so, instead of asking for a system permission that will not be applied.
		if (s.has('userns_mode')) {
			console.error(`[omarchyd] ${appId}: userns_mode is ignored by Podman and was left out of ${pairKey(pair)}`)
			s.delete('userns_mode')
		}
		const dep = s.get('depends_on')
		if (YAML.isSeq(dep)) dep.items = dep.items.filter((item) => asJSON(item) !== 'app_proxy')
		else if (YAML.isMap(dep)) dep.delete('app_proxy')
		// Store apps find their own services as <app>_<service>_1 (e.g. immich_postgres_1).
		if (!s.get('container_name') && s.get('network_mode') !== 'host') s.set('container_name', `${appId}_${pairKey(pair)}_1`)
	}
	if (shared) {
		const existing = doc.get('networks')
		// A map parsed from the file has .set. One just assigned is a plain object (Document.get unwraps it).
		if (YAML.isMap(existing)) existing.set('default', {name: SHARED_NETWORK, external: true})
		else doc.set('networks', {...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}), default: {name: SHARED_NETWORK, external: true}})
	}
	const byName = {}
	for (const pair of serviceNodes.items) if (YAML.isMap(pair.value)) byName[pairKey(pair)] = pair.value
	const services = Object.fromEntries(Object.entries(byName).map(([k, n]) => [k, n.toJSON() ?? {}]))
	// APP_PORT / APP_HOST may name a variable from the app's exports.sh (e.g. $APP_MEMPOOL_PORT).
	const resolved = (v) => {
		const n = varName(v)
		return n && vars[n] !== undefined ? String(vars[n]) : String(v ?? '')
	}
	const appPort = Number(resolved(proxy.APP_PORT))
	const host = String(proxy.APP_HOST ?? '').trim()
	let internalPort = null
	let webContainerPort = null
	let boundService = null // the service that received the web loopback publish
	const containerPort = (p) => Number(String(typeof p === 'object' ? p.target : p).split('/')[0].split(':').pop())
	if (Number.isInteger(appPort) && appPort > 0) {
		webContainerPort = appPort
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
			appendPort(byName[key], `127.0.0.1:${internalPort}:${appPort}`)
			boundService = key
		}
	}
	// TouchWorkStation listings are plain Docker Compose files: the listing names its web service and
	// port (web: {service, port}). Any host port the file publishes for it (so it also runs on its own
	// with `docker compose up`) gives way to Omarchy Server's private one behind the sign-in.
	if (!internalPort && web && services[web.service] && Number.isInteger(web.port)) {
		const svc = byName[web.service]
		webContainerPort = web.port
		if (services[web.service].network_mode === 'host') {
			internalPort = null // holds its own port, like Home Assistant
		} else {
			retainPorts(svc, (p) => containerPort(p) !== web.port)
			internalPort = allocatePort()
			appendPort(svc, `127.0.0.1:${internalPort}:${web.port}`)
			boundService = web.service
		}
	}
	// MCP is published on 127.0.0.1 only. The web loopback is reused only for the service that got it.
	const mcpPort = typeof mcp?.port === 'string' && mcp.port.trim() ? Number(mcp.port) : mcp?.port
	const mcpSvc = mcp?.service ? services[mcp.service] : null
	let mcpInternalPort = null
	const sameBinding = boundService !== null && mcp?.service === boundService && webContainerPort !== null && mcpPort === webContainerPort
	if (mcpSvc && typeof mcpPort === 'number' && Number.isInteger(mcpPort) && mcpPort >= 1 && mcpPort <= 65535) {
		if (sameBinding) mcpInternalPort = internalPort
		else if (mcpSvc.network_mode !== 'host') {
			retainPorts(byName[mcp.service], (p) => containerPort(p) !== mcpPort)
			mcpInternalPort = allocatePort()
			appendPort(byName[mcp.service], `127.0.0.1:${mcpInternalPort}:${mcpPort}`)
		} else if (boundService === null && internalPort && webContainerPort !== null && mcpPort === webContainerPort) {
			// The app binds this port on 127.0.0.1 itself. Nothing else can publish it.
			mcpInternalPort = internalPort
		}
	}
	return {text: emitCompose(doc), internalPort, mcpInternalPort}
}

// Can a browser use this app's web page right now? One answer for every screen:
//   ready         its page answers (a sign-in page or a "not found" counts: the app is there)
//   starting      not answering yet, and it was started only a moment ago
//   unreachable   its containers run, but nothing answers on its web port (see `result`/`error`)
//   stopped       its containers aren't running
//   gateway-down  the app answers, but Omarchy Server's own port for it isn't open
//   no-web        it has no web page
// `probe` is what asking the app gave: {result: 'answered' | 'refused' | 'timeout' | 'error' | 'no-web', status}.
export function readinessOf({probe, container = 'running', runningForMs = Infinity, graceMs = 120_000, gatewayOpen = true}) {
	if (probe.result === 'no-web') return 'no-web'
	const answered = probe.result === 'answered'
	if (answered && (probe.status ?? 500) < 500) return gatewayOpen ? 'ready' : 'gateway-down'
	if (container === 'stopped') return 'stopped'
	if (runningForMs < graceMs) return 'starting'
	// Still a server error after it has had time to start: open it, its own page says what's wrong.
	if (answered) return gatewayOpen ? 'ready' : 'gateway-down'
	return 'unreachable'
}

// Whether Podman itself works (issue #88), not just whether its socket file is there. The common way
// it breaks: its storage was made for another user or home folder (a renamed user, a restored backup,
// a copied VM), so it refuses to start, and apps only say "Cannot connect to the Docker daemon".
export async function podmanHealth(run, env, home) {
	const storageHelp = (where) =>
		`Podman’s storage still belongs to ${where}, not to ${home}, so it won’t start (this happens after renaming the user or restoring another machine’s home folder). Move ~/.local/share/containers aside, or run “podman system reset”, then reinstall your apps.`
	try {
		const res = await run('podman', ['info', '--format', 'json'], {env, timeout: 30_000})
		let info = null
		try {
			info = JSON.parse(typeof res === 'string' ? res : (res?.stdout ?? ''))
		} catch {
			/* nothing to compare: it ran, so it works */
		}
		const root = String(info?.store?.graphRoot ?? '')
		if (root && root.startsWith('/home/') && !root.startsWith(home + '/')) return {ok: false, message: storageHelp(root.replace(/\/\.local\/share\/containers\/storage$/, ''))}
		return {ok: true}
	} catch (e) {
		const text = `${e.stderr ?? ''} ${e.message ?? ''}`
		const other = /(\/home\/[^/\s"']+)\/\.local\/share\/containers/.exec(text)?.[1]
		if (e.code === 'ENOENT') return {ok: false, message: 'Apps need Podman. Run the Omarchy Server installer again to add it.'}
		if ((other && other !== home) || /does not match our (static|graph|run|tmp) dir/i.test(text)) return {ok: false, message: storageHelp(other && other !== home ? other : 'another user')}
		return {ok: false, message: `Podman didn’t start: ${text.replace(/^\s*(podman:\s*)?(Error:\s*)?/i, '').trim().split('\n').slice(-1)[0].slice(0, 300)}`}
	}
}

export function createApps({dataDir, home = os.homedir(), webPort = 7780, run = execP, gatewayHost = '0.0.0.0', allowFileStores = false, firewall = null, defaultStores = DEFAULT_STORES, tlsDir = join(dataDir, 'tls'), secure = tlsContext({dir: tlsDir, lazy: true}), startGraceMs = 120_000, systemApps = null, deviceExists = exists}) {
	const base = join(dataDir, 'apps')
	const storesDir = join(base, 'stores')
	const installedDir = join(base, 'installed')
	const stateFile = join(base, 'apps.json')
	const engineEnv = {DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/podman/podman.sock`}

	let state = {stores: [], apps: [], recent: []}
	// Set when apps.json exists but cannot be used. Saves refuse, so a later install cannot
	// replace the bytes the owner may still be able to repair.
	let stateDamaged = false
	let secret
	let publishToken = ''
	let publishServer = null
	const publishSock = join(base, 'publish.sock')
	const publishTokenFile = join(base, 'publish.token')
	const busy = new Map() // appId -> {state, progress}
	const lock = createKeyedLock()
	let statesCache = new Map(), statesAt = 0, statesInFlight = null
	// When an app stops being busy (installed, started, stopped…), look at it afresh next time.
	const busyDelete = busy.delete.bind(busy)
	busy.delete = (id) => (statesAt = 0, busyDelete(id))
	const gateways = new Map() // appId -> {server, port}
	const tickets = new Map() // one-time hand-overs from the web app
	let registryCache = null
	let registryGen = 0
	let registryFlightGen = 0
	let registryWarm = null

	// Apps come back after a reboot only if Podman's own restart unit is on (it's off by default, and
	// rootless Podman has no daemon to do it). It's a user unit, so this needs no sudo: servers set up
	// before the installer did it get it here too (issue #89).
	run('systemctl', ['--user', 'enable', 'podman-restart.service'], {timeout: 20_000}).catch(() => {})
	const ready = (async () => {
		await mkdir(storesDir, {recursive: true, mode: 0o700})
		await mkdir(installedDir, {recursive: true, mode: 0o700})
		// Only a missing file is a new install. Empty, truncated, or wrong-shaped JSON must stay
		// byte-for-byte: the migrations below would otherwise save an empty app list over it.
		let text = null
		try {
			text = await readFile(stateFile, 'utf8')
		} catch (error) {
			if (error.code !== 'ENOENT') stateDamaged = true
		}
		if (text !== null && !stateDamaged) {
			let data
			try {
				data = JSON.parse(text)
			} catch {
				data = undefined
			}
			const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
			const ok =
				plain(data) &&
				Array.isArray(data.apps) &&
				data.apps.every(plain) &&
				Array.isArray(data.stores) &&
				data.stores.every((s) => plain(s) && typeof s.url === 'string') &&
				(data.recent === undefined || Array.isArray(data.recent))
			if (ok) state = {...state, ...data, recent: Array.isArray(data.recent) ? data.recent : []}
			else stateDamaged = true
		}
		if (stateDamaged) console.error('[omarchyd] couldn’t load apps.json; leaving it unchanged')
		const sf = join(base, 'secret')
		try {
			secret = await readFile(sf)
		} catch {
			secret = randomBytes(32)
			await writeFile(sf, secret, {mode: 0o600})
		}
		if (stateDamaged) return
		await chmod(base, 0o700).catch(() => {})
		try {
			publishToken = (await readFile(publishTokenFile, 'utf8')).trim()
			if (!publishToken) throw new Error('empty')
		} catch {
			publishToken = randomBytes(32).toString('base64url')
			await writeFile(publishTokenFile, `${publishToken}\n`, {mode: 0o644})
		}
		// The apps directory is private to this user. 0644 lets a container read the mounted file
		// (its user is not this one). Other accounts still cannot traverse the directory.
		await chmod(publishTokenFile, 0o644).catch(() => {})
		await rm(publishSock, {force: true}).catch(() => {})
		publishServer = http.createServer(async (req, res) => {
			const url = new URL(req.url ?? '/', 'http://localhost')
			if (req.method !== 'POST' || !PUBLISH_RPC.has(url.pathname)) {
				sendError(res, new RpcError('NOT_FOUND', 'This socket only publishes and unpublishes apps'))
				return
			}
			await handleRpc(req, res, url, {'apps.publish': {kind: 'mutation', run: publish}, 'apps.unpublish': {kind: 'mutation', run: unpublish}}, authenticatePublish)
		})
		await new Promise((resolve, reject) => {
			publishServer.once('error', reject)
			publishServer.listen(publishSock, resolve)
		})
		publishServer.unref()
		await chmod(publishSock, 0o666).catch(() => {})
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
		// A local clone of the catalog (file://) replaces the GitHub store so App Store and updates
		// read the tree you sync, the same way Software update reads the local omarchy-server clone.
		const localDefault = defaultStores.find((d) => /^file:\/\//.test(d.url))
		if (localDefault) {
			let changed = false
			for (const s of state.stores) {
				if (!isGithubAppStore(s.url)) continue
				await rm(storeDir(s.url), {recursive: true, force: true}).catch(() => {})
				s.url = localDefault.url
				s.syncedAt = 0
				changed = true
			}
			for (const a of state.apps) {
				if (!isGithubAppStore(a.store)) continue
				a.store = localDefault.url
				changed = true
			}
			if (!state.stores.some((s) => s.url.toLowerCase() === localDefault.url.toLowerCase())) {
				state.stores.unshift({url: localDefault.url, syncedAt: 0})
				changed = true
			}
			if (changed) await save()
		}
		for (const a of state.apps) if (a.state === 'installing') Object.assign(a, {state: 'error', error: 'Install was interrupted. Uninstall it and install again.'})
		// Newer versions ask about more kinds of access (host network, server folders, system access).
		// Apps you already installed keep what they have, so they keep working and updating.
		if ((state.permissionsVersion ?? 1) < 2) {
			for (const a of state.apps) {
				if (!Array.isArray(a.permissions)) continue
				const c = await readYaml(appDir(a.id), ['compose.omarchy.yml', ...COMPOSE_FILES]).catch(() => null)
				if (!c) continue
				const text = await readFile(join(appDir(a.id), c.name), 'utf8').catch(() => '')
				a.permissions = [...new Set([...a.permissions, ...appPermissions(text, whereFor(a)).map((p) => p.id)])]
			}
			state.permissionsVersion = 2
			await save()
		}
		// Apps installed before their own data under ~/.local was claimed have an empty dataDirs
		// list, so the container user never received it. Jellyfin runs as user 1000 and then cannot
		// write /config. Claim those folders once. A later start does not chown them again.
		let claimed = false
		for (const a of state.apps) {
			if (a.system || a.state === 'error') continue
			const previousDirs = a.dataDirs
			const previousUsers = a.userDirs
			try {
				const text = await readFile(join(appDir(a.id), 'compose.omarchy.yml'), 'utf8').catch(() => '')
				if (!text) continue
				const had = new Set(a.dataDirs ?? [])
				await createBindSources(a, text)
				const fresh = (a.dataDirs ?? []).filter((d) => !had.has(d))
				if (!fresh.length) continue
				await prepareOwnership({...a, dataDirs: fresh, userDirs: []})
				claimed = true
			} catch (e) {
				a.dataDirs = previousDirs
				a.userDirs = previousUsers
				console.error('[omarchyd] ownership', a.id, e.message)
			}
		}
		if (claimed) await save()
		for (const a of state.apps) if (a.system && a.state !== 'error') systemApps?.resume(a)
		for (const a of state.apps) if (a.port && a.state !== 'error') await openGateways(a).catch((e) => console.error('[omarchyd] gateway', a.id, e.message))
	})()
	const save = () => (stateDamaged ? Promise.reject(new RpcError('PRECONDITION_FAILED', 'apps.json is damaged and was left unchanged.')) : writeAtomic(stateFile, () => JSON.stringify(state)))
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
		// Browsers send a server's cookies to every port on it, so Omarchy Server's own sign-in cookies
		// (the web app's session, omarchyd's browser session, the app session) arrive here too. None of
		// them is ever passed to an app: an app that saw them could act as you in Omarchy Server.
		const cookies = (h.cookie ?? '')
			.split(';')
			.map((c) => c.trim())
			.filter((c) => c && !OWN_COOKIE.test(c.slice(0, c.indexOf('=') >>> 0)))
		if (cookies.length) h.cookie = cookies.join('; ')
		else delete h.cookie
		h['x-forwarded-for'] = req.socket.remoteAddress ?? ''
		h['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'
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
			// Never pass on a proof someone typed themselves; add the real one for its own app.
			delete h['x-omarchy-gateway']
			if (view) {
				for (const k of Object.keys(h)) if (k.startsWith('x-forwarded-')) delete h[k]
			} else h['x-omarchy-gateway'] = deriveEntropy(`app-${app.id}-gateway`)
			return h
		}
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://x')
			// "Always use the secure address" (Settings): a browser opening a page over http:// is sent to https://.
			if (wantsUpgrade(req, secure.policy?.(), secure.get())) {
				res.writeHead(308, {location: `https://${hostOnly(req)}:${listenPort}${safePath(req.url)}`, 'cache-control': 'no-store'})
				return res.end()
			}
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
				const back = `${req.socket.encrypted ? 'https' : 'http'}://${hostOnly(req)}:${webPort}/api/app-enter?app=${encodeURIComponent(app.id)}&r=${encodeURIComponent(safePath(req.url))}${view ? '&view=1' : ''}`
				res.writeHead(302, {location: back, 'cache-control': 'no-store'})
				return res.end()
			}
			// Some apps serve their own page over https inside the container (self-signed): talk https to them.
			const upstreamHttps = !view && app.internalHttps
			const up = (upstreamHttps ? https : http).request({host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: headersFor(req), timeout: 120_000, ...(upstreamHttps ? {rejectUnauthorized: false} : {})}, (r) => {
				up.setTimeout(0) // it answered: long-lived responses (live updates, downloads) are fine
				// Nor may an app set them (it could swap in a session of its choosing).
				const headers = {...r.headers}
				if (headers['set-cookie']) headers['set-cookie'] = [].concat(headers['set-cookie']).filter((c) => !OWN_COOKIE.test(String(c).trim().split('=')[0]))
				res.writeHead(r.statusCode ?? 502, frameable(headers, hostOnly(req)))
				r.pipe(res)
			})
			up.on('timeout', () => up.destroy(new Error('timeout')))
			linkProxy(req, res, up)
			up.on('error', () => {
				if (res.headersSent) return
				res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'})
				res.end(`${app.name ?? app.id} isn’t answering yet. If it just started, give it a moment.`)
			})
			req.pipe(up)
		})
		server.on('upgrade', (req, socket, head) => {
			if (!checkSession(parseCookies(req.headers.cookie)[APP_COOKIE])) {
				socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
				return
			}
			const onUp = () => {
				const h = headersFor(req)
				const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))]
				up.write(`${lines.join('\r\n')}\r\n\r\n`)
				if (head?.length) up.write(head)
				up.pipe(socket)
				socket.pipe(up)
			}
			const up = !view && app.internalHttps ? tls.connect({host: '127.0.0.1', port: target, rejectUnauthorized: false}, onUp) : net.connect(target, '127.0.0.1', onUp)
			up.on('error', () => socket.destroy())
			socket.on('error', () => up.destroy())
		})
		// http:// and https:// on the same port (see tls.mjs).
		await secure.start()
		const front = dualProtocolServer(server, secure.get)
		await new Promise((resolve, reject) => {
			front.once('error', reject)
			front.listen(listenPort, gatewayHost, resolve)
		})
		gateways.set(key, {server, front, port: listenPort})
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
			g.front?.close()
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
		if (defaultStores.some((d) => /^file:\/\//.test(d.url) && normalize(d.url) === url)) return
		throw new RpcError('BAD_REQUEST', 'Enter the store’s https:// address, e.g. https://github.com/someone/app-store')
	}
	async function loadStore(url) {
		const dir = storeDir(url)
		let meta = (await readYaml(dir, STORE_FILES))?.data
		const gallery = GALLERIES[url.toLowerCase().replace(/\.git$/, '')] ?? (typeof meta?.gallery === 'string' && /^https:\/\//.test(meta.gallery) ? meta.gallery.replace(/\/+$/, '') : null)
		const apps = []
		// First pass: every app and the variables each one's exports.sh provides (apps that need
		// another app read that app's variables, such as its address and passwords).
		const entries = (await readdir(dir, {withFileTypes: true})).filter((e) => e.isDirectory() && !e.name.startsWith('.'))
		const found = (
			await mapPool(entries, LOAD_CONCURRENCY, async (entry) => {
				const appPath = join(dir, entry.name)
				const [m, c, exportsText] = await Promise.all([readYaml(appPath, APP_FILES).catch(() => null), readFirst(appPath, COMPOSE_FILES).catch(() => null), readFile(join(appPath, 'exports.sh'), 'utf8').catch(() => '')])
				if (!m?.data?.id || m.data.id !== entry.name || !APP_ID.test(m.data.id) || !c) return null
				// `export NAME=…`, a bare `export NAME`, or one written out for later (echo "export NAME=…" >> .env).
				const exported = [...exportsText.matchAll(/\bexport\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((x) => x[1])
				return {a: m.data, entry, compose: c.text, exported}
			})
		).filter(Boolean)
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
			const mcp = parseMcp(a.mcp)
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
				shared: a.shared === true || deps.length > 0 || neededByOthers.has(a.id) || /ipv4_address/.test(compose),
				defaultUsername: a.defaultUsername || undefined,
				defaultPassword: a.defaultPassword || undefined,
				deterministicPassword: a.deterministicPassword === true,
				// Needs a secure (https://) page in the browser, e.g. for WebCodecs or the Web Crypto API.
				...(a.requiresHttps === true ? {requiresHttps: true} : {}),
				...(Array.isArray(a.openPorts) ? {openPorts: a.openPorts.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535 && n !== 22 && n !== mcp?.port).slice(0, 16)} : {}),
				...(folderChoices(a.folders).length ? {folders: folderChoices(a.folders)} : {}),
				...(a.web && typeof a.web.service === 'string' && Number.isInteger(Number(a.web.port)) ? {web: {service: a.web.service, port: Number(a.web.port), ...(a.web.https === true ? {https: true} : {})}} : {}),
				...(mcp ? {mcp} : {}),
				...(a.publish === true ? {publish: true} : {}),
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
	const syncFlights = new Map()
	async function syncStore(url) {
		const key = url.toLowerCase()
		const inflight = syncFlights.get(key)
		if (inflight) return inflight
		const flight = syncStoreNow(url).finally(() => {
			if (syncFlights.get(key) === flight) syncFlights.delete(key)
		})
		syncFlights.set(key, flight)
		return flight
	}
	async function syncStoreNow(url) {
		const dir = storeDir(url)
		if (await exists(join(dir, '.git'))) {
			// A shallow clone can't `pull --ff-only` once the store has moved on (the new tip doesn't
			// connect to the one commit it has), so take the store's latest commit as it is.
			await run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', 'HEAD'], {timeout: 120_000})
			await run('git', ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], {timeout: 60_000})
			await run('git', ['-C', dir, 'clean', '-fdx'], {timeout: 60_000})
		} else await run('git', ['clone', '--depth', '1', '--', url, dir], {timeout: 120_000})
	}
	let registryFlight = null
	// A publish rewrites the local store while a registry read may already be in flight. Drop that
	// read, and do not let it cache the listing it started with.
	function dropRegistry() {
		registryGen += 1
		registryCache = null
		registryFlight = null
	}
	async function registry({refresh = false} = {}) {
		await ready
		if (registryFlight && registryFlightGen === registryGen) return registryFlight
		if (registryCache && registryCache.gen === registryGen && !refresh && Date.now() - registryCache.at < 60 * 60_000) return registryCache.list
		const gen = registryGen
		const flight = loadRegistry({refresh, gen}).finally(() => {
			if (registryFlight === flight) registryFlight = null
		})
		registryFlight = flight
		registryFlightGen = gen
		return flight
	}
	async function loadRegistry({refresh = false, gen = registryGen} = {}) {
		const list = []
		let dirty = false
		for (const s of state.stores) {
			if (refresh || Date.now() - (s.syncedAt ?? 0) > 60 * 60_000) {
				// A failed download rejects every caller waiting on this read. It is not turned
				// into an empty store, and the flight is dropped so the next read tries again.
				await syncStore(s.url)
				s.syncedAt = Date.now()
				dirty = true
			}
			try {
				const loaded = await loadStore(s.url)
				if (s.name) loaded.meta.name = s.name
				const prev = s.meta
				s.meta = loaded.meta
				if (!prev || prev.id !== loaded.meta.id || prev.name !== loaded.meta.name) dirty = true
				list.push(loaded)
			} catch {}
		}
		try {
			if ((await readdir(storeDir(IMPORTED_STORE))).length) list.push(await loadStore(IMPORTED_STORE))
		} catch {
			/* nothing imported */
		}
		try {
			if ((await readdir(storeDir(PUBLISHED_STORE))).length) list.push(await loadStore(PUBLISHED_STORE))
		} catch {
			/* nothing published */
		}
		// Apps that are part of the server itself (Tailscale) come first, so a store can't stand in for them.
		if (systemApps) list.unshift({url: BUILTIN_STORE, meta: {id: 'omarchy-server', name: 'Omarchy Server'}, apps: systemApps.listings()})
		// Installed apps pick up how their listing says to open them (https, an https app inside),
		// so an app installed before its listing changed doesn't need reinstalling.
		for (const app of state.apps) {
			if (app.system) continue
			const src = list.find((l) => !app.store || l.url === app.store)?.apps.find((x) => x.id === app.id) ?? list.flatMap((l) => l.apps).find((x) => x.id === app.id)
			if (!src) continue
			const requiresHttps = !!src.requiresHttps
			const internalHttps = !!src.web?.https
			if (!!app.requiresHttps !== requiresHttps || !!app.internalHttps !== internalHttps) dirty = true
			if (requiresHttps) app.requiresHttps = true
			else delete app.requiresHttps
			if (internalHttps) app.internalHttps = true
			else delete app.internalHttps
		}
		if (dirty) await save()
		if (gen === registryGen) registryCache = {at: Date.now(), list, gen}
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
			HOME: home,
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
			// For apps that need a key of exactly 32 characters (Laravel's APP_KEY, for one).
			APP_SEED_32: deriveEntropy(`app-${app.id}-seed`).slice(0, 32),
			// Community-store compose files reach shared folders through this root; it maps
			// <root>/data/storage/downloads to your Downloads folder.
			UMBREL_ROOT: join(base, 'shared-root'),
			// TouchWorkStation listings: your own folders and this server's address, by name.
			...Object.fromEntries(Object.entries(USER_DIRS).map(([k, d]) => [k, join(home, d)])),
			SERVER_IP: serverIp(),
			DOCKER_SOCKET: engineEnv.DOCKER_HOST.replace(/^unix:\/\//, ''),
			PUID: String(APP_UID),
			PGID: String(APP_UID),
			// Sent by its sign-in gateway with every request (x-omarchy-gateway), so an app that
			// leaves sign-in to Omarchy Server can tell requests that came through it.
			APP_GATEWAY_KEY: deriveEntropy(`app-${app.id}-gateway`),
			// Folders you placed when installing (its listing's `folders:`); otherwise inside the app.
			...Object.fromEntries((app.folderIds ?? []).map((id) => [folderVar(id), app.folders?.[id] ?? join(dir, 'folders', id)])),
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
	const usbFile = (id) => join(appDir(id), 'compose.usb.yml')
	async function writeUsbOverlay(app) {
		const path = usbFile(app.id)
		const text = await readFile(join(appDir(app.id), 'compose.omarchy.yml'), 'utf8').catch(() => '')
		const names = Object.keys((YAML.parse(text) ?? {}).services ?? {})
		const plugged = []
		// deviceExists is access() on the server. A test can answer for a stick path when a private /dev is not available.
		for (const d of app.usbDevices ?? []) if (d?.path && (await deviceExists(d.path))) plugged.push(d)
		const overlay = usbComposeOverlay(names, plugged)
		if (!overlay) await rm(path, {force: true})
		else await writeFile(path, overlay, {mode: 0o600})
		return plugged.map((d) => d.id)
	}
	async function compose(app, ...args) {
		const files = ['-f', join(appDir(app.id), 'compose.omarchy.yml')]
		const extra = usbFile(app.id)
		if (await exists(extra)) files.push('-f', extra)
		try {
			return await run('docker-compose', ['-p', project(app.id), ...files, ...args], {env: composeEnv(app), cwd: appDir(app.id)})
		} catch (e) {
			// "Cannot connect to the Docker daemon" means Podman itself isn't answering: say why instead.
			if (/Cannot connect to the Docker daemon|podman\.sock.*(refused|no such file)/i.test(String(e.message))) {
				const h = await engineHealth({fresh: true})
				if (!h.ok) throw new RpcError('PRECONDITION_FAILED', h.message)
			}
			throw e
		}
	}
	// An image built on this server (localhost/…) is not in a registry. `compose pull` would fail it.
	async function pullApp(app) {
		const text = await readFile(join(appDir(app.id), 'compose.omarchy.yml'), 'utf8').catch(() => '')
		let local = false
		try {
			const doc = YAML.parse(text) ?? {}
			const images = Object.values(doc.services ?? {}).map((s) => s?.image).filter(Boolean)
			local = images.length > 0 && images.every((img) => String(img).startsWith('localhost/'))
		} catch {}
		if (!local) await compose(app, 'pull')
	}

	// Bind-mount sources that don't exist yet are folders the app expects to own (Podman won't
	// create them the way Docker does).
	async function createBindSources(app, text) {
		const overlay = {...process.env, ...composeEnv(app)}
		const dotenv = expandDotEnv(parseDotEnv(await readFile(join(appDir(app.id), '.env'), 'utf8').catch(() => '')), overlay)
		const env = {...dotenv, ...overlay}
		const shared = join(base, 'shared-root')
		const doc = YAML.parse(text) ?? {}
		app.dataDirs = []
		app.userDirs = []
		const dir = appDir(app.id)
		const allowed = [dir, shared, ...Object.values(USER_DIRS).map((d) => join(home, d)), ...Object.values(app.folders ?? {}).filter((p) => typeof p === 'string')]
		for (const s of Object.values(doc.services ?? {})) {
			for (const v of s?.volumes ?? []) {
				// Expand first: a source like ${APP_DATA_DIR:-.}/data has a colon of its own.
				const src = typeof v === 'string' ? expandVars(v, env).split(':')[0] : v?.source && expandVars(v.source, env)
				if (!src) continue
				const path = bindHostPath(src, {home, cwd: dir})
				if (!path.startsWith('/') || path.includes('\0') || CLOCK_FILES.includes(path)) continue
				const real = realpathExisting(path)
				// Drop escaped app-dir symlinks even when the target is refused, so Compose cannot follow them.
				// Never touch host files such as /etc/localtime (those are not under the app folder).
				if (under(path, dir) && (await lstat(path).then((st) => st.isSymbolicLink(), () => false))) {
					const target = await realpath(path).catch(() => '')
					// The app folder and the shared root sit under ~/.local. A link that stays inside
					// them is the app's own data, not a way out to SSH keys or this server's files.
					const ownTarget = target && (under(target, dir) || under(target, shared))
					const ok = ownTarget || (target && allowed.some((d) => under(target, d)) && !refusedMount(target, home))
					if (!ok) await rm(path, {force: true})
				}
				// Hidden home folders are refused, except the app's own folder and the shared root.
				// Judge where it really is: a link inside the app folder can lead anywhere.
				const own = under(real, dir) || under(real, shared)
				if (!own && (refusedMount(real, home) || refusedMount(path, home))) continue
				// One of your folders (Videos, Music…): make sure it exists and let the app's user in.
				const mine = Object.values(USER_DIRS).map((d) => join(home, d)).find((d) => under(path, d) || under(real, d))
				if (mine) {
					if (!(await exists(path))) await mkdir(path, {recursive: true})
					app.userDirs = [...new Set([...(app.userDirs ?? []), mine])]
					continue
				}
				// Only inside the app's own folder, or the shared folders (e.g. a Downloads subfolder).
				if (!under(path, dir) && !under(path, shared) && !under(real, dir) && !under(real, shared)) continue
				if (!(await exists(path))) await mkdir(path, {recursive: true})
				// Folders inside the app's own folder are its data: they get handed to its container user.
				if (under(path, dir) && under(realpathExisting(path), dir) && path !== dir && (await lstat(path).then((st) => st.isDirectory(), () => false))) app.dataDirs.push(path)
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
	const removeAppDir = async (id) => {
		if (!(await exists(appDir(id)))) return
		await run('podman', ['unshare', 'rm', '-rf', appDir(id)], {env: engineEnv}).catch(() => rm(appDir(id), {recursive: true, force: true}))
	}

	// An app's exports.sh (bash from its store) sets extra variables, such as ports or derived
	// passwords. It runs in a bubblewrap sandbox: no network, read-only system, only its own app folder
	// (writable, as some keep generated passwords there), a clean environment, and a time limit. Its exported variables are returned.
	async function runExports(app) {
		const dir = appDir(app.id)
		if (!(await exists(join(dir, 'exports.sh')))) return {}
		const base = composeEnv({...app, exports: {}})
		const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address).join(' ')
		// The server's key never enters the sandbox. derive_entropy looks its answer up in a table
		// made here; an identifier that isn't in it yet is noted, and the script runs again with it
		// (same values as before, so nothing an app stored changes). Apps installed from 0.9.4 on
		// get only their own values ("app-<its id>-…"), not another app's.
		const own = `app-${app.id}-`
		const allowed = (id) => !app.ownSecretsOnly || id.startsWith(own)
		const MARK = '__OMARCHY_WANTED__'
		const script = [
			'derive_entropy() { local v; v=$(printf "%s\\n" "$OMARCHY_DERIVED" | awk -F "\\t" -v id="$1" \'$1 == id { print $2; exit }\'); if [ -z "$v" ]; then printf "%s\\n" "$1" >> /tmp/.wanted; v=0000000000000000000000000000000000000000000000000000000000000000; fi; printf "%s" "$v"; }',
			'hostname() { case "$1" in -I|--all-ip-addresses) echo "$OMARCHY_HOST_IPS" ;; *) echo "$DEVICE_HOSTNAME" ;; esac; }',
			'app_entropy_identifier="app-${APP_ID}-seed"',
			'EXPORTS_APP_ID="$APP_ID" EXPORTS_APP_DIR="$APP_DATA_DIR" EXPORTS_TOR_DATA_DIR="$TOR_DATA_DIR"',
			'cd "$APP_DATA_DIR" && . ./exports.sh >/dev/null 2>&1',
			'unset OMARCHY_DERIVED',
			'env -0',
			`if [ -f /tmp/.wanted ]; then printf '${MARK}\\0'; tr '\\n' '\\0' < /tmp/.wanted; fi`,
		].join('\n')
		const table = new Map()
		const refused = new Set()
		let result = {}
		for (let pass = 0; pass < 4; pass++) {
			const env = {...base, OMARCHY_DERIVED: [...table].map(([k, v]) => `${k}\t${v}`).join('\n'), OMARCHY_HOST_IPS: ips, PATH: '/usr/bin'}
			delete env.DOCKER_HOST
			const setenv = Object.entries(env).flatMap(([k, v]) => ['--setenv', k, String(v)])
			const out = await run(
				'bwrap',
				['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64', '--ro-bind', '/etc/ssl', '/etc/ssl', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', dir, dir, '--unshare-all', '--die-with-parent', '--clearenv', ...setenv, '/usr/bin/bash', '-c', script],
				{timeout: 15_000},
			).catch(() => '')
			const parts = out.split('\0')
			const at = parts.indexOf(MARK)
			const wanted = at < 0 ? [] : parts.slice(at + 1).filter((id) => id && !table.has(id) && !refused.has(id))
			result = {}
			for (const pair of at < 0 ? parts : parts.slice(0, at)) {
				const i = pair.indexOf('=')
				const k = pair.slice(0, i)
				if (i > 0 && /^[A-Z][A-Z0-9_]*$/.test(k) && !(k in env) && k !== 'PWD' && k !== 'SHLVL' && k !== 'OLDPWD' && k !== '_') result[k] = pair.slice(i + 1)
			}
			if (!wanted.length) break
			for (const id of wanted.slice(0, 64)) {
				if (id.length > 512 || /[\t\n]/.test(id) || !allowed(id)) {
					refused.add(id)
					console.error(`[omarchyd] ${app.id}: exports.sh asked for another app’s secret (${id.slice(0, 80)}); refused`)
				} else table.set(id, deriveEntropy(id))
			}
		}
		return result
	}

	async function engineAvailable() {
		const ok = await run('docker-compose', ['version'], {env: engineEnv}).then(() => true, () => false)
		const sock = engineEnv.DOCKER_HOST.replace(/^unix:\/\//, '')
		return ok && (await exists(sock))
	}

	// Whether Podman itself works, not just whether its socket file is there (see podmanHealth).
	let health = null
	async function engineHealth({fresh = false} = {}) {
		if (!fresh && health && Date.now() - health.at < 30_000) return health
		health = {...(await podmanHealth(run, engineEnv, home)), at: Date.now()}
		return health
	}

	async function liveState(a) {
		if (a.system) return systemApps ? systemApps.liveState(a) : 'unknown'
		try {
			const text = (await compose(a, 'ps', '-a', '--format', 'json')).trim()
			const rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
			const states = rows.map((r) => String(r.State ?? r.state ?? '').toLowerCase())
			return states.length && states.some((s) => s === 'running') ? 'running' : 'stopped'
		} catch {
			return 'unknown'
		}
	}
	// Every app's live state, for the app list (polled every few seconds by each open page). One
	// `podman ps` for all apps instead of a `docker-compose ps` per app; polls that arrive together
	// share one check; and the list never waits more than a moment on it. While podman is busy (a
	// big image downloading for an install), the last known states are used, so the list keeps
	// answering and a new install shows up straight away instead of after the download.
	async function readStates() {
		const apps = state.apps.filter((a) => !busy.has(a.id) && a.state !== 'error')
		const out = new Map()
		let rows = null
		// Only container apps need the engine (Tailscale and other system apps don't).
		if (!apps.some((a) => !a.system)) rows = []
		else try {
			const text = await run('podman', ['ps', '-a', '--format', 'json'], {env: engineEnv, timeout: 15_000})
			const parsed = JSON.parse(text || 'null')
			if (Array.isArray(parsed)) rows = parsed
		} catch {}
		if (rows) {
			const byProject = new Map()
			for (const r of rows) {
				const p = r.Labels?.['com.docker.compose.project']
				if (p) byProject.set(p, [...(byProject.get(p) ?? []), String(r.State ?? '').toLowerCase()])
			}
			await Promise.all(
				apps.map(async (a) => {
					if (a.system) return out.set(a.id, await liveState(a))
					const states = byProject.get(project(a.id)) ?? []
					out.set(a.id, states.some((x) => x === 'running') ? 'running' : 'stopped')
				}),
			)
		} else await Promise.all(apps.map(async (a) => out.set(a.id, await liveState(a))))
		return out
	}
	async function liveStates() {
		if (Date.now() - statesAt < 1500) return statesCache
		statesInFlight ??= readStates()
			.then((m) => ((statesCache = m), (statesAt = Date.now()), m))
			.finally(() => (statesInFlight = null))
		// Don't hold the list up: after 3 s, answer with what we last knew (the check carries on).
		return Promise.race([statesInFlight, new Promise((r) => setTimeout(() => r(statesCache), 3000).unref?.())])
	}

	// When each app was last started, as far as this process knows (apps already running when
	// omarchyd started count from then). Tells "still starting" from "running but not answering".
	const bootedAt = Date.now()
	const startedAt = new Map()
	const markStarted = (id) => startedAt.set(id, Date.now())

	// Ask the app's web port directly (not through its gateway), the way the gateway reaches it:
	// https when the listing says the app itself speaks https.
	function askWeb(app) {
		const target = app.internalPort ?? app.port
		if (!target) return Promise.resolve({result: 'no-web'})
		const secureUpstream = !!app.internalPort && !!app.internalHttps
		return new Promise((resolve) => {
			const opts = {host: '127.0.0.1', port: target, path: app.path || '/', method: 'GET', timeout: 6000, headers: {accept: 'text/html'}, ...(secureUpstream ? {rejectUnauthorized: false} : {})}
			const req = (secureUpstream ? https : http).request(opts, (r) => {
				r.resume()
				resolve({result: 'answered', status: r.statusCode, location: r.headers.location ?? null})
			})
			req.on('timeout', () => (req.destroy(), resolve({result: 'timeout'})))
			req.on('error', (e) => resolve({result: e.code === 'ECONNREFUSED' ? 'refused' : 'error', error: e.code ?? e.message}))
			req.end()
		})
	}
	async function probe(app) {
		const asked = await askWeb(app)
		if (asked.result === 'no-web') return {...asked, readiness: 'no-web'}
		const gatewayUp = () => gateways.has(app.id) || gateways.has(gatewayKey(app.id, true))
		// The gateway should be open whenever the app is installed; if it isn't, open it again.
		if (!gatewayUp() && app.port && !busy.has(app.id)) await openGateways(app).catch(() => {})
		const answeredOk = asked.result === 'answered' && asked.status < 500
		const container = answeredOk ? 'running' : busy.has(app.id) ? 'running' : await liveState(app)
		const runningForMs = busy.has(app.id) ? 0 : Date.now() - (startedAt.get(app.id) ?? bootedAt)
		const readiness = readinessOf({probe: asked, container, runningForMs, graceMs: startGraceMs, gatewayOpen: gatewayUp()})
		return {...asked, gateway: gatewayUp(), container, runningFor: Math.round(runningForMs / 1000), readiness}
	}

	// ---- procedures -----------------------------------------------------------------------------
	async function list() {
		await ready
		// Read the stores once after start, in the background, so installed apps get any listing changes.
		if (!registryCache && !registryWarm) registryWarm = registry().catch(() => {}).finally(() => (registryWarm = null))
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
				...(a.requiresHttps ? {requiresHttps: true} : {}),
				...(a.system ? {system: true} : {}),
				state: b?.state ?? (a.state === 'error' ? 'unknown' : (live.get(a.id) ?? 'unknown')),
				...(b?.progress !== undefined ? {progress: b.progress} : {}),
				...(a.state === 'error' ? {error: a.error} : {}),
				credentials: (() => {
					const password = a.deterministicPassword ? appPassword(a.id) : a.defaultPassword
					const apiToken = a.store === PUBLISHED_STORE && !!password && (a.openPorts?.length ?? 0) > 0
					return {defaultUsername: a.defaultUsername, defaultPassword: password, showBeforeOpen: !!password, ...(apiToken ? {label: 'API token'} : {})}
				})(),
				...(a.store === PUBLISHED_STORE && a.openPorts?.[0] ? {apiPort: a.openPorts[0]} : {}),
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
	// The prepared compose file may already have the address filled in. The store file still names the variable.
	async function composeMentionsTor(dir) {
		for (const name of ['compose.omarchy.yml', ...COMPOSE_FILES]) {
			const text = await readFile(join(dir, name), 'utf8').catch(() => '')
			if (/\$\{?TOR_PROXY_IP\b/.test(text) || text.includes(TOR_PROXY_IP)) return true
		}
		return false
	}
	// `exceptId` is the app being removed. Tor stops only when nothing still installed uses it.
	async function stopTorIfIdle(exceptId) {
		const dir = join(base, 'system', 'tor')
		const file = join(dir, 'compose.yml')
		if (!(await exists(file))) return
		for (const other of state.apps) {
			if (other.id === exceptId) continue
			if (await composeMentionsTor(appDir(other.id))) return
		}
		await run('docker-compose', ['-p', 'omarchy-tor', '-f', file, 'down'], {env: engineEnv, cwd: dir})
		await rm(dir, {recursive: true, force: true})
	}

	// The store's files for an app, into its folder. On an update the folder already holds the app's
	// data, owned by its container user: files the app keeps in those data folders are left as they
	// are (an update never resets your app's settings), and the rest is copied from inside Podman's
	// user namespace when your own user may not write there.
	async function copyListing(src, app) {
		const dir = appDir(app.id)
		const fresh = !(await exists(dir))
		// Listing-dir symlinks that point outside the listing (for example keys → ~/.ssh) must not
		// be copied: Compose would bind the target, and chown would follow it.
		const filter = async (p) => {
			if (p.split('/').includes('.git')) return false
			const st = await lstat(p).catch(() => null)
			if (!st?.isSymbolicLink()) return true
			const target = await realpath(p).catch(() => null)
			const root = await realpath(src.folder).catch(() => src.folder)
			return !!(target && under(target, root))
		}
		if (fresh) return cp(src.folder, dir, {recursive: true, filter})
		const stage = await mkdtemp(join(base, `.update-${app.id}-`))
		try {
			await cp(src.folder, stage, {recursive: true, filter})
			const data = (app.dataDirs ?? []).filter((d) => d.startsWith(`${dir}/`))
			for (const rel of await readdir(stage, {recursive: true})) {
				const target = join(dir, rel)
				const inData = data.some((d) => target === d || target.startsWith(`${d}/`))
				if (!inData) continue
				const isFile = await stat(join(stage, rel)).then((st) => !st.isDirectory(), () => false)
				if (isFile && (await lstat(target).then(() => true, () => false))) await rm(join(stage, rel), {force: true})
			}
			try {
				await cp(stage, dir, {recursive: true, force: true})
			} catch (error) {
				if (!['EACCES', 'EPERM'].includes(error.code)) throw error
				await run('podman', ['unshare', 'cp', '-rT', '--no-preserve=ownership', stage, dir], {env: engineEnv})
			}
		} finally {
			await rm(stage, {recursive: true, force: true}).catch(() => {})
		}
	}

	// Loopback ports already given to other apps (web gateway target and MCP).
	function takenLoopbacks(exceptId) {
		const used = new Set()
		for (const other of state.apps) {
			if (other.id === exceptId) continue
			if (other.internalPort) used.add(other.internalPort)
			if (other.mcpInternalPort) used.add(other.mcpInternalPort)
		}
		return used
	}

	function systemPortFor(app) {
		const used = takenLoopbacks(app.id)
		let p = 20_000 + (parseInt(createHash('sha256').update(app.id).digest('hex').slice(0, 4), 16) % 9000)
		while (used.has(p)) p++
		return p
	}

	async function placeApp(src, app) {
		const dir = appDir(app.id)
		await copyListing(src, app)
		// Its variables first: the compose file's web address and port can depend on them.
		app.exports = await runExports(app)
		const c = await readYaml(dir, COMPOSE_FILES)
		const text = await readFile(join(dir, c.name), 'utf8')
		// Other apps' ports (an update keeps the app's own). A second call is the MCP loopback port.
		const used = takenLoopbacks(app.id)
		const prepared = prepareCompose(app.id, text, () => {
			let p = 20_000 + (parseInt(createHash('sha256').update(app.id).digest('hex').slice(0, 4), 16) % 9000)
			while (used.has(p)) p++
			used.add(p)
			return p
		}, {shared: !!src.shared, vars: composeEnv(app), web: src.web ?? null, mcp: src.mcp ?? null})
		app.shared = !!src.shared
		if (app.shared) await ensureSharedNetwork()
		if (/\$\{?TOR_PROXY_IP\b/.test(text)) await ensureTor()
		// Container managers get your own (rootless) container socket, never a root one.
		let finalText = prepared.text
		if ((app.permissions ?? []).includes('containers')) {
			const sock = engineEnv.DOCKER_HOST.replace(/^unix:\/\//, '')
			const edited = YAML.parseDocument(finalText)
			if (edited.errors.length) throw edited.errors[0]
			const services = edited.get('services')
			if (YAML.isMap(services)) {
				for (const pair of services.items) {
					if (!YAML.isMap(pair.value)) continue
					const volumes = pair.value.get('volumes')
					if (!YAML.isSeq(volumes)) continue
					for (const item of volumes.items) {
						if (!YAML.isScalar(item) || typeof item.value !== 'string' || !SOCKET.test(item.value.split(':')[0])) continue
						item.value = [sock, ...item.value.split(':').slice(1)].join(':')
					}
				}
			}
			finalText = emitCompose(edited)
		}
		if ((app.permissions ?? []).includes('publish')) finalText = await attachPublish(finalText, app)
		// System ports (below 1024): only for apps you allowed; the helper lowers the limit once.
		// Expand with the env Compose will bind: the app .env, process env, and composeEnv (exports.sh).
		const dotenv = parseDotEnv(await readFile(join(dir, '.env'), 'utf8').catch(() => ''))
		const low = appPermissions(finalText, whereFor(app, dotenv)).find((p) => p.id === 'low-ports')
		if (low && (app.permissions ?? []).includes('low-ports') && firewall?.lowPorts) await firewall.lowPorts(Math.min(...low.what.map(Number)))
		prepared.text = finalText
		await writeFile(join(dir, 'compose.omarchy.yml'), prepared.text, {mode: 0o600})
		await createBindSources(app, prepared.text)
		if (prepared.mcpInternalPort) app.mcpInternalPort = prepared.mcpInternalPort
		else delete app.mcpInternalPort
		return prepared.internalPort
	}

	// Is `need` already covered by an installed app (itself, or one that stands in for it, such
	// as Bitcoin Knots for Bitcoin Node)?
	const satisfied = (need) => state.apps.some((a) => a.state !== 'error' && (a.id === need || (a.implements ?? []).includes(need)))

	// The extra access a listing's compose file asks for.
	// The folders an app may use without asking, and how its variables expand, for appPermissions.
	function whereFor(app, dotenv = {}) {
		// Before you place them, an app's folders count as its own (inside the app's folder).
		// After placing, `folders` is id → path and Compose will expand FOLDER_* to those paths.
		const folderIds = app.folderIds ?? (Array.isArray(app.folders) ? app.folders.map((f) => f.id) : [])
		const folders = app.folders && !Array.isArray(app.folders) ? app.folders : undefined
		const env = composeEnv({id: app.id, port: app.port, version: app.version, folderIds, folders, exports: app.exports})
		const merged = {...expandDotEnv(dotenv, {...process.env, ...env}), ...process.env, ...env}
		return {
			home,
			cwd: appDir(app.id),
			expand: (v) => expandVars(String(v), merged).replace(/^\.(?=\/|$)/, appDir(app.id)).replace(/^~(?=\/|$)/, home),
			allowed: [appDir(app.id), join(base, 'shared-root'), ...Object.values(USER_DIRS).map((d) => join(home, d)), ...Object.values(folders ?? {})],
		}
	}
	const publishPermission = () => ({id: 'publish', ...PERMISSIONS.publish, what: []})
	async function permissionsOf(src) {
		if (src.system) return systemApps?.permissions(src.id) ?? []
		const c = await readYaml(src.folder, COMPOSE_FILES).catch(() => null)
		if (!c) return src.publish === true ? [publishPermission()] : []
		const dotenv = parseDotEnv(await readFile(join(src.folder, '.env'), 'utf8').catch(() => ''))
		const perms = appPermissions(await readFile(join(src.folder, c.name), 'utf8'), whereFor(src, dotenv))
		if (src.publish === true && !perms.some((p) => p.id === 'publish')) perms.push(publishPermission())
		return perms
	}
	// A studio that you allowed to publish gets the tool, the token, and a socket that serves only
	// those two calls. The socket is not in the listing: the server adds it after you allow it.
	async function attachPublish(text, app) {
		const doc = YAML.parse(text) ?? {}
		const env = composeEnv(app)
		const expand = (v) => expandVars(String(v), {...process.env, ...env}).replace(/^~(?=\/|$)/, home)
		const lines = []
		const seen = new Set()
		for (const svc of Object.values(doc.services ?? {})) {
			if (!svc || typeof svc !== 'object') continue
			for (const v of svc.volumes ?? []) {
				if (typeof v !== 'string' || !v.includes(':')) continue
				const parts = v.split(':')
				if (parts.length >= 3 && /^(ro|rw|z|Z)$/.test(parts.at(-1))) parts.pop()
				const dest = parts.pop()
				const hostPath = bindHostPath(expand(parts.join(':')), {home, cwd: appDir(app.id)}).replace(/\/+$/, '')
				const container = (expand(dest).replace(/\/+$/, '') || '/').replace(/\/+$/, '') || '/'
				if (!container.startsWith('/') || container.split('/').includes('..')) continue
				if (!under(hostPath, home) || hostPath === home) continue
				if (/[\n\r\t]/.test(container) || /[\n\r\t]/.test(hostPath)) continue
				if (hostPath.slice(home.length).split('/').some((part) => part.startsWith('.'))) continue
				if (refusedMount(hostPath, home)) continue
				const line = `${container}\t${hostPath}`
				if (seen.has(line)) continue
				seen.add(line)
				lines.push(line)
			}
			svc.volumes = [...(svc.volumes ?? []), `${publishSock}:/run/omarchy/publish.sock`, `${publishTokenFile}:/run/omarchy/publish.token:ro`, `${join(appDir(app.id), 'publish.mounts')}:/run/omarchy/publish.mounts:ro`, `${PUBLISH_CLI}:/usr/local/bin/omarchy-publish:ro`]
			const vars = {OMARCHY_PUBLISH_SOCK: '/run/omarchy/publish.sock', OMARCHY_PUBLISH_TOKEN: '/run/omarchy/publish.token', OMARCHY_PUBLISH_MOUNTS: '/run/omarchy/publish.mounts'}
			if (Array.isArray(svc.environment)) {
				svc.environment = svc.environment.filter((e) => !Object.keys(vars).some((k) => String(e).startsWith(`${k}=`)))
				svc.environment.push(...Object.entries(vars).map(([k, val]) => `${k}=${val}`))
			} else svc.environment = {...(svc.environment ?? {}), ...vars}
		}
		await writeFile(join(appDir(app.id), 'publish.mounts'), `${lines.join('\n')}${lines.length ? '\n' : ''}`, {mode: 0o644})
		return YAML.stringify(doc)
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
		return lock(`install:${id}`, async () => {
			if (stateDamaged) throw new RpcError('PRECONDITION_FAILED', 'apps.json is damaged and was left unchanged.')
			// A failed install stays until the plan and the checks succeed. Deleting it first
			// made a later port conflict look like the app was gone.
			if (state.apps.some((a) => a.id === id && a.state !== 'error')) throw new RpcError('CONFLICT', 'That app is already installed')
			const plan = await installPlan(id)
			if (plan.some((src) => !src.system)) {
				if (!(await engineAvailable())) throw new RpcError('PRECONDITION_FAILED', 'Apps need Podman. Run the Omarchy Server installer again to add it.')
				const h = await engineHealth({fresh: true})
				if (!h.ok) throw new RpcError('PRECONDITION_FAILED', h.message)
			}
			if (plan.some((src) => src.system) && !systemApps) throw new RpcError('PRECONDITION_FAILED', 'This server can’t install system apps')
			// Check every port first, so nothing starts installing if one of them can't.
			const ports = new Set()
			for (const src of plan) {
				if (!src.port) continue
				if (src.port < 1024 || src.port > 65535 || RESERVED(src.port)) throw new RpcError('PRECONDITION_FAILED', `${src.name} wants port ${src.port}, which Omarchy Server keeps for itself`)
				// Error-state apps are about to be replaced, so their recorded ports are not in use.
				if (ports.has(src.port) || state.apps.some((a) => a.port === src.port && a.state !== 'error') || !(await portFree(src.port))) throw new RpcError('CONFLICT', `Port ${src.port} is already in use, so ${src.name} can’t be installed`)
				ports.add(src.port)
			}
			// Folders you placed yourself (see folderChoices): checked, and made, before anything installs.
			const placed = new Map()
			for (const f of Array.isArray(input?.folders) ? input.folders : []) {
				const src = plan.find((p) => p.id === f?.appId)
				if (!src || !(src.folders ?? []).some((c) => c.id === f.id) || !f.path) continue
				const path = String(f.path).replace(/\/+$/, '')
				if (!folderAllowed(path, home)) throw new RpcError('BAD_REQUEST', `${src.name} can’t use ${path}: pick a folder inside your home folder (not a hidden one).`)
				// The deepest part that already exists must really be there, not a link to somewhere else.
				let probe = path
				while (!(await exists(probe))) probe = probe.slice(0, probe.lastIndexOf('/')) || '/'
				const real = await realpath(probe)
				if (real !== probe && !folderAllowed(join(real, path.slice(probe.length)), home)) throw new RpcError('BAD_REQUEST', `${path} leads outside your home folder, so ${src.name} can’t use it.`)
				if ((await exists(path)) && !(await stat(path)).isDirectory()) throw new RpcError('BAD_REQUEST', `${path} isn’t a folder.`)
				placed.set(`${src.id}/${f.id}`, path)
			}
			for (const path of placed.values()) await mkdir(path, {recursive: true})
			// Extra access: after folders are placed, so FOLDER_* is the path Compose will expand.
			const granted = new Set(Array.isArray(input?.grant) ? input.grant.map(String) : [])
			const needs = new Map()
			for (const src of plan) {
				const folderIds = (src.folders ?? []).map((f) => f.id)
				const folders = Object.fromEntries(folderIds.filter((fid) => placed.has(`${src.id}/${fid}`)).map((fid) => [fid, placed.get(`${src.id}/${fid}`)]))
				const perms = await permissionsOf({...src, folderIds, folders})
				const refused = perms.find((p) => p.id === 'refused')
				if (refused) throw new RpcError('FORBIDDEN', `${src.name} asks for folders Omarchy Server never gives an app: ${refused.what.join(', ')}.`)
				needs.set(src.id, perms.map((p) => p.id))
			}
			const missing = [...new Set([...needs.values()].flat())].filter((p) => !granted.has(p))
			if (missing.length) throw new RpcError('PRECONDITION_FAILED', `Installing needs your permission: ${missing.map((p) => PERMISSIONS[p].label.toLowerCase()).join(', ')}.`)
			// Checks passed: clear the failed app and failed dependencies the same way, then start over.
			let cleared = false
			for (const src of plan) {
				const failed = state.apps.find((a) => a.id === src.id && a.state === 'error')
				if (!failed) continue
				if (await exists(join(appDir(src.id), 'compose.omarchy.yml'))) await compose(failed, 'down', '--remove-orphans').catch(() => {})
				await removeAppDir(src.id)
				state.apps = state.apps.filter((a) => a !== failed)
				cleared = true
			}
			if (cleared) await save()
			// Every app in the plan shows as installing right away; they then install one after another.
			const queued = plan.map((src) => {
				const leftover = state.apps.find((a) => a.id === src.id && a.state === 'error')
				if (leftover) state.apps = state.apps.filter((a) => a !== leftover)
				const app = {id: src.id, name: src.name, version: src.version, icon: src.icon, port: src.port, path: src.path, defaultUsername: src.defaultUsername, defaultPassword: src.defaultPassword, deterministicPassword: src.deterministicPassword, ...(src.requiresHttps ? {requiresHttps: true} : {}), ...(src.web?.https ? {internalHttps: true} : {}), ...(src.openPorts?.length ? {openPorts: src.openPorts} : {}), ...(src.mcp ? {mcp: src.mcp} : {}), ...(src.store ? {store: src.store} : {}), ...(src.implements?.length ? {implements: src.implements} : {}), ...(src.folders?.length ? {folderIds: src.folders.map((f) => f.id), folders: Object.fromEntries(src.folders.filter((f) => placed.has(`${src.id}/${f.id}`)).map((f) => [f.id, placed.get(`${src.id}/${f.id}`)]))} : {}), installedAt: Date.now(), state: 'installing', permissions: needs.get(src.id) ?? [], ownSecretsOnly: true}
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
					if (src.system) {
						try {
							app.system = true
							app.store = BUILTIN_STORE
							app.internalPort = systemPortFor(app)
							busy.set(app.id, {state: 'installing', progress: 20})
							await systemApps.install(app)
							markStarted(app.id)
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
						continue
					}
					try {
						await sharedRoot()
						app.internalPort = await placeApp(src, app)
						await prepareOwnership(app)
						busy.set(app.id, {state: 'installing', progress: 15})
						await pullApp(app)
						busy.set(app.id, {state: 'installing', progress: 85})
						await compose(app, 'up', '-d', '--remove-orphans')
						markStarted(app.id)
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
		})
	}

	async function update(input) {
		await ready
		const app = findInstalled(String(input?.appId ?? ''))
		if (app.system) throw new RpcError('PRECONDITION_FAILED', `${app.name} is updated with the rest of the system (Omarchy’s updates).`)
		if (busy.has(app.id)) throw new RpcError('CONFLICT', `${app.name} is busy`)
		busy.set(app.id, {state: 'updating', progress: 0})
		let src
		let wants
		try {
			src = await findInRegistry(app.id)
			if (!src) throw new RpcError('NOT_FOUND', 'That app is no longer in your stores')
			// An update never adds access you didn't allow. (Apps installed before permissions existed keep what they run with.)
			const wantsPerms = await permissionsOf({...src, folderIds: app.folderIds, folders: app.folders && !Array.isArray(app.folders) ? app.folders : undefined})
			const refused = wantsPerms.find((p) => p.id === 'refused')
			if (refused) throw new RpcError('FORBIDDEN', `${src.name} asks for folders Omarchy Server never gives an app: ${refused.what.join(', ')}.`)
			wants = wantsPerms.map((p) => p.id)
			app.permissions ??= wants
			const extra = wants.filter((p) => !app.permissions.includes(p) && !(Array.isArray(input?.grant) && input.grant.includes(p)))
			if (extra.length) throw new RpcError('PRECONDITION_FAILED', `This update asks for more access (${extra.map((p) => PERMISSIONS[p].label.toLowerCase()).join(', ')}). Uninstall and install it again to allow that.`)
			for (const p of Array.isArray(input?.grant) ? input.grant.map(String) : []) if (wants.includes(p) && !app.permissions.includes(p)) app.permissions.push(p)
			// Folders a newer listing lets you place start inside the app; the ones you placed stay put.
			if (src.folders?.length) app.folderIds = [...new Set([...(app.folderIds ?? []), ...src.folders.map((f) => f.id)])]
		} catch (error) {
			busy.delete(app.id)
			throw error
		}
		busy.set(app.id, {state: 'updating', progress: 10})
		let step = 'getting its files ready'
		// placeApp records the new loopback port before the new containers are up. Keep the old one if that fails.
		const previousMcpPort = app.mcpInternalPort
		const composePath = join(appDir(app.id), 'compose.omarchy.yml')
		const previousCompose = await readFile(composePath).catch(() => null)
		const previousExports = app.exports
		const usbPath = usbFile(app.id)
		const previousUsb = await readFile(usbPath).catch(() => null)
		let switched = false
		let usbWritten = false
		try {
			const internalPort = await placeApp(src, app)
			await writeUsbOverlay(app)
			usbWritten = true
			await prepareOwnership(app)
			step = 'downloading the new version'
			busy.set(app.id, {state: 'updating', progress: 25})
			// The old version keeps running (and stays reachable) while the new one downloads.
			await pullApp(app)
			step = 'starting the new version'
			busy.set(app.id, {state: 'updating', progress: 85})
			closeGateway(app.id)
			app.internalPort = internalPort
			switched = true
			await compose(app, 'up', '-d', '--remove-orphans')
			markStarted(app.id)
			app.permissions = [...new Set([...app.permissions, ...wants])]
			const nextPorts = [...(src.openPorts ?? [])]
			for (const p of app.openPorts ?? []) if (!nextPorts.includes(p)) await firewall?.close(p)
			if (nextPorts.length) app.openPorts = nextPorts
			else delete app.openPorts
			Object.assign(app, {version: src.version, name: src.name, icon: src.icon, path: src.path, requiresHttps: src.requiresHttps || undefined, internalHttps: src.web?.https || undefined})
			if (src.mcp) app.mcp = src.mcp
			else delete app.mcp
			delete app.state
			delete app.error
		} catch (error) {
			if (!switched) {
				if (previousMcpPort) app.mcpInternalPort = previousMcpPort
				else delete app.mcpInternalPort
			}
			// placeApp rewrites the compose file and exports before pull. Put them back if pull or up fails.
			if (previousCompose) await writeFile(composePath, previousCompose, {mode: 0o600}).catch(() => {})
			else await rm(composePath, {force: true}).catch(() => {})
			if (usbWritten) {
				if (previousUsb) await writeFile(usbPath, previousUsb, {mode: 0o600}).catch(() => {})
				else await rm(usbPath, {force: true}).catch(() => {})
			}
			if (previousExports === undefined) delete app.exports
			else app.exports = previousExports
			if (error instanceof RpcError) throw error
			console.error(`[omarchyd] updating ${app.id}:`, error)
			const detail = String(error.message ?? error).replace(/\s+/g, ' ').trim().slice(-300)
			throw new RpcError('BAD_GATEWAY', `Couldn’t update ${app.name} while ${step}: ${detail}`)
		} finally {
			// Reachable again whatever happened: the new version, or the old one still running.
			await openGateways(app).catch((e) => console.error(`[omarchyd] reopening ${app.id}:`, e.message))
			busy.delete(app.id)
			await save().catch(() => {})
		}
		return true
	}

	const lifecycle = (args, pending) => async (input) => {
		await ready
		const app = findInstalled(String(input?.appId ?? ''))
		if (busy.has(app.id)) throw new RpcError('CONFLICT', `${app.name} is busy`)
		busy.set(app.id, {state: pending})
		try {
			let pluggedIds = null
			if (!app.system && (args[0] === 'up' || args[0] === 'restart')) pluggedIds = await writeUsbOverlay(app)
			if (app.system) await systemApps[{up: 'start', stop: 'stop', restart: 'restart'}[args[0]]](app)
			// `restart` leaves the running container on the old device list. Recreate so the overlay just written is what runs.
			else if (args[0] === 'restart') await compose(app, 'up', '-d', '--force-recreate')
			else await compose(app, ...args)
			if (args[0] === 'up' || args[0] === 'restart') {
				markStarted(app.id)
				if (!app.system) {
					app.usbApplied = pluggedIds ?? []
					await save()
				}
			}
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
			// A failed `down` (or a system uninstall) leaves the app in place so it can be retried.
			try {
				if (app.system) await systemApps?.uninstall(app)
				if (await exists(join(appDir(app.id), 'compose.omarchy.yml'))) await compose(app, 'down', '--volumes', '--remove-orphans')
				await stopTorIfIdle(app.id)
			} catch (error) {
				if (error instanceof RpcError) throw error
				console.error(`[omarchyd] uninstalling ${app.id}:`, error)
				const detail = String(error.message ?? error).replace(/\s+/g, ' ').trim().slice(-300)
				throw new RpcError('BAD_GATEWAY', `Couldn’t uninstall ${app.name ?? app.id}: ${detail}`)
			}
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
		const stores = await registry()
		const byId = new Map(stores.flatMap((s) => s.apps.map((a) => [a.id, a])))
		const out = []
		for (const a of state.apps) {
			if (a.system) continue
			let src = null
			if (a.store) {
				const st = stores.find((x) => x.url.toLowerCase() === a.store.toLowerCase())
				src = st?.apps.find((x) => x.id === a.id) ?? null
			} else {
				for (const st of stores) {
					const hit = st.apps.find((x) => x.id === a.id && !x.web)
					if (hit) {
						src = hit
						break
					}
				}
			}
			src ??= byId.get(a.id)
			if (src?.version && a.version && src.version !== a.version) out.push({id: a.id, version: src.version})
		}
		return out
	}

	// A shell inside an installed app's main container (the one the gateway forwards to).
	async function shellFor(appId) {
		await ready
		const app = findInstalled(String(appId))
		if (app.system) throw new RpcError('PRECONDITION_FAILED', `${app.name} runs on the server itself, not in a container. Use the Terminal.`)
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

	// What each app's containers use right now (podman stats takes a moment, so it runs in the
	// background and the last reading is returned).
	let appUsage = {at: 0, list: [], running: null}
	const parseSize = (t) => {
		const m = /([\d.]+)\s*([kKMGT]?i?B)/.exec(String(t ?? ''))
		if (!m) return 0
		const unit = m[2].toUpperCase().replace('I', '')
		const base = /I/i.test(m[2].slice(1, 2)) ? 1024 : 1000
		return Number(m[1]) * base ** ({B: 0, KB: 1, MB: 2, GB: 3, TB: 4}[unit] ?? 0)
	}
	async function measureApps() {
		const ps = JSON.parse((await run('podman', ['ps', '--format', 'json'], {env: engineEnv, timeout: 15_000}).catch(() => '[]')) || '[]')
		const appOf = new Map()
		for (const c of ps) {
			const proj = c.Labels?.['com.docker.compose.project'] ?? ''
			const id = proj.startsWith('omarchy-') ? proj.slice(8) : null
			if (id && state.apps.some((a) => a.id === id)) appOf.set(c.Id, id)
		}
		if (!appOf.size) return (appUsage = {at: Date.now(), list: [], running: null})
		const stats = JSON.parse((await run('podman', ['stats', '--no-stream', '--format', 'json'], {env: engineEnv, timeout: 30_000}).catch(() => '[]')) || '[]')
		const by = new Map()
		for (const s of stats) {
			const full = [...appOf.keys()].find((k) => k.startsWith(s.id ?? s.ID ?? '')) ?? null
			const id = full && appOf.get(full)
			if (!id) continue
			const cur = by.get(id) ?? {cpuShare: 0, memBytes: 0}
			// podman reports CPU per core (100% = one core busy).
			cur.cpuShare += (parseFloat(s.cpu_percent ?? s.CPUPerc ?? '0') || 0) / 100
			cur.memBytes += parseSize(String(s.mem_usage ?? s.MemUsage ?? '').split('/')[0])
			by.set(id, cur)
		}
		appUsage = {at: Date.now(), list: [...by].map(([id, u]) => ({id, ...u})), running: null}
	}
	function usage() {
		return appUsage.list
	}
	function refreshUsage() {
		if (!appUsage.running) appUsage.running = measureApps().catch(() => (appUsage.running = null))
	}

	// Running installed apps that declared mcp:. Loopback only; never an openPort.
	async function mcpTargets() {
		await ready
		const live = await liveStates()
		const out = []
		for (const a of state.apps) {
			if (!a.mcp || !a.mcpInternalPort) continue
			const b = busy.get(a.id)
			const shown = b?.state ?? (a.state === 'error' ? 'unknown' : (live.get(a.id) ?? 'unknown'))
			if (shown !== 'running' && shown !== 'ready') continue
			const path = typeof a.mcp.path === 'string' && a.mcp.path.startsWith('/') ? a.mcp.path : `/${a.mcp.path ?? ''}`
			out.push({appId: a.id, name: a.name, url: `http://127.0.0.1:${a.mcpInternalPort}${path}`, transport: a.mcp.transport, running: true})
		}
		return out
	}

	const assertOwner = (auth) => {
		if (auth?.userId !== 'owner') throw new RpcError('FORBIDDEN', 'Only the server’s owner can publish apps')
	}
	// A bearer token from the publish file. It is not a sign-in: other procedures ignore it.
	function authenticatePublish(req) {
		const path = String(req?.url ?? '').split('?')[0]
		if (!PUBLISH_RPC.has(path)) return null
		const bearer = /^Bearer (\S+)$/.exec(req?.headers?.authorization ?? '')?.[1]
		if (!bearer || !publishToken) return null
		const got = Buffer.from(bearer)
		const want = Buffer.from(publishToken)
		if (got.length !== want.length || !timingSafeEqual(got, want)) return null
		return {userId: 'owner', kind: 'publish'}
	}
	async function assertBinary(binary) {
		const real = await realpath(String(binary ?? '')).catch(() => '')
		if (!real) throw new RpcError('BAD_REQUEST', 'That binary isn’t there')
		const homeReal = await realpath(home).catch(() => home)
		const underHome = real === homeReal || real.startsWith(`${homeReal}/`)
		const hidden = real.slice(homeReal.length).split('/').some((part) => part.startsWith('.'))
		if (!underHome || hidden || refusedMount(real, homeReal)) throw new RpcError('BAD_REQUEST', 'The binary has to be a file inside your home folder')
		const st = await stat(real)
		if (!st.isFile()) throw new RpcError('BAD_REQUEST', 'The binary has to be a file inside your home folder')
		if (st.size > 512 * 1024 * 1024) throw new RpcError('BAD_REQUEST', 'That binary is larger than 512 MB')
		return real
	}
	// Files the published web page serves (a generated app's static/). Ordinary files only.
	async function assertAssets(dir) {
		const real = await realpath(String(dir ?? '')).catch(() => '')
		if (!real) throw new RpcError('BAD_REQUEST', 'Those files aren’t there')
		const homeReal = await realpath(home).catch(() => home)
		const hidden = real.slice(homeReal.length).split('/').some((part) => part.startsWith('.'))
		if (!(real === homeReal || real.startsWith(`${homeReal}/`)) || hidden || refusedMount(real, homeReal)) throw new RpcError('BAD_REQUEST', 'Those files have to be inside your home folder')
		if (!(await stat(real)).isDirectory()) throw new RpcError('BAD_REQUEST', 'Those files have to be a folder')
		const pending = [real]
		let size = 0
		while (pending.length) {
			const dir = pending.pop()
			for (const name of await readdir(dir)) {
				if (name.startsWith('.')) throw new RpcError('BAD_REQUEST', 'Those files can’t include a hidden folder')
				const path = join(dir, name)
				const st = await lstat(path)
				if (st.isSymbolicLink()) throw new RpcError('BAD_REQUEST', 'Those files can’t include a link')
				if (st.isDirectory()) pending.push(path)
				else if (st.isFile()) {
					size += st.size
					if (size > 64 * 1024 * 1024) throw new RpcError('BAD_REQUEST', 'Those files are larger than 64 MB')
				} else throw new RpcError('BAD_REQUEST', 'Those files have to be ordinary files')
			}
		}
		return real
	}
	// Wrap a release binary in a small image. The studio never gets the Podman socket.
	// The image runs the proxy, not the binary: the token stays in the container's environment.
	async function buildRuntimeImage(id, version, binary, ports, assets) {
		const tag = `localhost/omarchy-published/${id}:${version}`
		const context = await mkdtemp(join(os.tmpdir(), 'omarchy-publish-'))
		try {
			await cp(binary, join(context, 'app'))
			await chmod(join(context, 'app'), 0o755)
			await cp(API_PROXY, join(context, 'api-proxy'))
			await chmod(join(context, 'api-proxy'), 0o755)
			await cp(BIND_SHIM, join(context, 'bind-localhost.c'))
			await cp(OMARCHY_SETUP, join(context, 'omarchy-setup.sh'))
			if (assets) await cp(assets, join(context, 'static'), {recursive: true})
			await writeFile(join(context, 'Containerfile'), runtimeContainerfile({...ports, assets: !!assets}))
			await run('podman', ['build', '-f', join(context, 'Containerfile'), '-t', tag, context], {env: engineEnv, timeout: 30 * 60_000})
		} finally {
			await rm(context, {recursive: true, force: true})
		}
		return tag
	}
	async function waitInstalled(id) {
		const end = Date.now() + 60_000
		for (;;) {
			const app = state.apps.find((a) => a.id === id)
			if (app && app.state !== 'installing' && !busy.has(id)) {
				if (app.state === 'error') throw new RpcError('BAD_GATEWAY', app.error || 'It didn’t install')
				return app
			}
			if (Date.now() > end) throw new RpcError('BAD_GATEWAY', 'Installing took too long')
			await new Promise((r) => setTimeout(r, 15))
		}
	}
	async function publish(input, ctx) {
		await ready
		assertOwner(ctx?.auth)
		const id = String(input?.appId ?? '')
		if (!APP_ID.test(id)) throw new RpcError('BAD_REQUEST', 'Use a short lowercase id, such as field-service')
		const name = String(input?.name ?? '').trim().slice(0, 80)
		if (!name) throw new RpcError('BAD_REQUEST', 'Give the app a name')
		const installed = state.apps.find((a) => a.id === id)
		if (installed && installed.store !== PUBLISHED_STORE) throw new RpcError('CONFLICT', `${installed.name} is already installed from another store`)
		// The port inside the app is the one other containers call. A later publish keeps it.
		let previousWeb = null
		if (installed) {
			try {
				const prev = YAML.parse(await readFile(join(storeDir(PUBLISHED_STORE), id, 'omarchy-app.yml'), 'utf8'))
				const n = Number(prev?.web?.port)
				if (Number.isInteger(n) && n >= 1 && n <= 65535) previousWeb = n
			} catch { /* the listing is rewritten below */ }
		}
		const containerPort = input?.containerPort === undefined ? (previousWeb ?? 7860) : Number(input.containerPort)
		if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new RpcError('BAD_REQUEST', 'The app’s own port has to be from 1 to 65535')
		if (installed && previousWeb !== null && containerPort !== previousWeb) throw new RpcError('PRECONDITION_FAILED', 'Unpublish it before changing the port inside the app')
		const publicPort = input?.port === undefined ? (installed?.port ?? containerPort) : Number(input.port)
		if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535 || RESERVED(publicPort)) throw new RpcError('BAD_REQUEST', 'Pick a port from 1024 up that Omarchy Server doesn’t keep for itself')
		if (installed && publicPort !== installed.port) throw new RpcError('PRECONDITION_FAILED', 'Unpublish it before changing its port')
		const version = String(input?.version ?? installed?.version ?? '1').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || '1'
		let image = typeof input?.image === 'string' ? input.image.trim() : ''
		const binary = input?.binary
		if (binary && image) throw new RpcError('BAD_REQUEST', 'Pass a binary or an image, not both')
		if (!binary && !image) throw new RpcError('BAD_REQUEST', 'Pass an image or a binary to publish')
		let mcp = null
		if (input?.mcp) {
			mcp = parseMcp({...input.mcp, service: 'web'})
			if (!mcp) throw new RpcError('BAD_REQUEST', 'MCP needs a port, a path starting with /, and transport http or sse')
		}
		// A binary gets a token and a second port. The web port stays behind sign-in. The API port
		// is the one on the LAN and on the shared network, and it accepts only the token.
		let apiHost = null
		let apiContainerPort = null
		let childPort = null
		let apiToken = null
		let assets = null
		if (binary) {
			const taken = new Set([publicPort])
			for (const other of state.apps) {
				if (other.id === id) continue
				if (other.port) taken.add(other.port)
				if (other.viewPort) taken.add(other.viewPort)
				for (const p of other.openPorts ?? []) taken.add(p)
			}
			const previousApi = installed?.openPorts?.[0]
			const avoidHost = new Set(taken)
			if (mcp?.port) avoidHost.add(mcp.port)
			apiHost = input?.apiPort === undefined ? (previousApi ?? nextHostPort(publicPort, avoidHost)) : Number(input.apiPort)
			if (!Number.isInteger(apiHost) || apiHost < 1024 || apiHost > 65535 || RESERVED(apiHost)) throw new RpcError('BAD_REQUEST', 'Pick an API port from 1024 up that Omarchy Server doesn’t keep for itself')
			if (apiHost === publicPort) throw new RpcError('BAD_REQUEST', 'The job API needs its own port')
			if (mcp?.port && apiHost === mcp.port) throw new RpcError('BAD_REQUEST', 'The job API can’t use the MCP port')
			if (installed && previousApi !== undefined && apiHost !== previousApi) throw new RpcError('PRECONDITION_FAILED', 'Unpublish it before changing its API port')
			if ((!installed || previousApi !== apiHost) && (taken.has(apiHost) || !(await portFree(apiHost)))) throw new RpcError('CONFLICT', `Port ${apiHost} is already in use`)
			const avoid = new Set([containerPort])
			if (mcp?.port) avoid.add(mcp.port)
			apiContainerPort = bumpPort(containerPort >= 65535 ? 1 : containerPort + 1, avoid)
			childPort = bumpPort(17860, new Set([...avoid, apiContainerPort]))
			if (!apiContainerPort || !childPort) throw new RpcError('BAD_REQUEST', 'No free port inside the app')
			apiToken = installed?.defaultPassword || randomBytes(32).toString('base64url')
			if (input?.assets) assets = await assertAssets(input.assets)
			image = await buildRuntimeImage(id, version, await assertBinary(binary), {webPort: containerPort, apiPort: apiContainerPort, childPort}, assets)
		} else if (!IMAGE_REF.test(image) || image.includes('..')) throw new RpcError('BAD_REQUEST', 'That image name can’t be published')
		const stores = await registry()
		if (stores.some((s) => s.url !== PUBLISHED_STORE && s.apps.some((a) => a.id === id))) throw new RpcError('CONFLICT', `${id} is already in another store`)
		const dir = storeDir(PUBLISHED_STORE)
		const appDirListing = join(dir, id)
		await mkdir(dir, {recursive: true, mode: 0o700})
		await writeFile(join(dir, 'omarchy-app-store.yml'), 'id: published\nname: Published on this server\n')
		await mkdir(appDirListing, {recursive: true})
		const envId = id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
		const callPort = apiContainerPort ?? containerPort
		const internalUrl = `http://${id}_web_1:${callPort}`
		const listing = {
			manifestVersion: 1,
			id,
			name,
			tagline: String(input?.tagline ?? name).slice(0, 140),
			category: typeof input?.category === 'string' && /^[a-z0-9-]{1,32}$/.test(input.category) ? input.category : 'developer',
			version,
			port: publicPort,
			shared: true,
			web: {service: 'web', port: containerPort},
			developer: 'Published on this server',
			...(apiToken ? {defaultPassword: apiToken} : {}),
			...(apiHost ? {openPorts: [apiHost]} : {}),
			description: String(input?.description ?? (apiToken
				? `Published from an app on this server. Programs on this server call ${internalUrl} with the API token. On the local network that same token is required on port ${apiHost}. The web page stays behind sign-in.`
				: `Published from an app on this server. Other apps on the shared network call ${internalUrl}.`)).slice(0, 2000),
			...(mcp ? {mcp} : {}),
		}
		await writeFile(join(appDirListing, 'omarchy-app.yml'), YAML.stringify(listing))
		const service = apiToken
			? {
				image,
				restart: 'unless-stopped',
				environment: {
					WEB_PORT: String(containerPort),
					API_PORT: String(apiContainerPort),
					CHILD_PORT: String(childPort),
					PORT: String(childPort),
					OMARCHY_API_TOKEN: apiToken,
					APP_GATEWAY_KEY: deriveEntropy(`app-${id}-gateway`),
				},
				ports: [`${containerPort}:${containerPort}`, `0.0.0.0:${apiHost}:${apiContainerPort}`],
			}
			: {
				image,
				restart: 'unless-stopped',
				environment: {PORT: String(containerPort)},
				ports: [`${containerPort}:${containerPort}`],
			}
		if (image.startsWith('localhost/')) service.pull_policy = 'never'
		await writeFile(join(appDirListing, 'docker-compose.yml'), YAML.stringify({services: {web: service}}))
		const exportsText = apiToken
			? `export APP_${envId}_URL=${internalUrl}\nexport APP_${envId}_HOST=${id}_web_1\nexport APP_${envId}_PORT=${callPort}\nexport APP_${envId}_LAN_PORT=${apiHost}\nexport APP_${envId}_TOKEN='${apiToken}'\n`
			: `export APP_${envId}_URL=${internalUrl}\nexport APP_${envId}_HOST=${id}_web_1\nexport APP_${envId}_PORT=${containerPort}\n`
		await writeFile(join(appDirListing, 'exports.sh'), exportsText)
		// update() keeps a password already on the app and does not copy one from the listing.
		if (installed && apiToken && !installed.defaultPassword) installed.defaultPassword = apiToken
		dropRegistry()
		if (installed) await update({appId: id})
		else {
			await install({appId: id, grant: []})
			await waitInstalled(id)
		}
		return {appId: id, name, image, version, store: PUBLISHED_STORE, url: internalUrl, port: publicPort, ...(apiToken ? {apiPort: apiHost, apiToken} : {}), updated: !!installed}
	}
	async function unpublish(input, ctx) {
		await ready
		assertOwner(ctx?.auth)
		const id = String(input?.appId ?? '')
		if (!APP_ID.test(id)) throw new RpcError('BAD_REQUEST', 'Use a short lowercase id, such as field-service')
		const installed = state.apps.find((a) => a.id === id)
		const listing = join(storeDir(PUBLISHED_STORE), id)
		if (installed && installed.store !== PUBLISHED_STORE) throw new RpcError('PRECONDITION_FAILED', `${installed.name} did not come from the published store`)
		if (!installed && !(await exists(listing))) throw new RpcError('NOT_FOUND', 'That app isn’t published')
		if (installed) await uninstall({appId: id})
		await rm(listing, {recursive: true, force: true})
		dropRegistry()
		return true
	}

	return {
		ready,
		usage,
		refreshUsage,
		mcpTargets,
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
			// An app that failed to uninstall may still need Tor. Otherwise the proxy stops here too,
			// including when a reset finds no apps left and the container is still up.
			await stopTorIfIdle(null)
			state.passGen = {}
			await save()
			return state.apps.length
		},
		close: () => {
			publishServer?.close()
			systemApps?.close()
			secure.close()
			for (const id of [...gateways.keys()]) closeGateway(id)
		},
		// For the Unraid importer: where its listings go, and installing one of them with the access its
		// listing asks for (the owner reviewed each app before the import started). Folders Omarchy Server
		// never gives an app stay refused.
		importedStoreDir: storeDir(IMPORTED_STORE),
		publishedStoreDir: storeDir(PUBLISHED_STORE),
		publishSock,
		// The publish token only authenticates apps.publish and apps.unpublish. Any other procedure
		// still needs a real sign-in, so a studio container can't uninstall the rest of the server.
		authenticatePublish,
		appDirFor: (id) => appDir(id),
		installed: (id) => state.apps.some((a) => a.id === id),
		async installImported(id) {
			dropRegistry()
			const plan = await installPlan(id)
			const grant = new Set()
			for (const a of plan) for (const p of await permissionsOf({...a, folderIds: [], folders: {}})) grant.add(p.id)
			if (grant.has('refused')) throw new RpcError('FORBIDDEN', 'It uses folders Omarchy Server never gives an app')
			await install({appId: id, grant: [...grant]})
		},
		importState(id) {
			const a = state.apps.find((x) => x.id === id)
			if (!a) return {done: true, error: 'It wasn’t installed'}
			return {done: a.state !== 'installing' && !busy.has(id), error: a.state === 'error' ? a.error || 'It didn’t install' : null}
		},
		// For backups: installed container apps, where their files are, and whether each is running.
		async backupTargets() {
			await ready
			const live = await liveStates().catch(() => new Map())
			return state.apps
				.filter((a) => !a.system && a.state !== 'installing' && a.state !== 'error')
				.map((a) => ({id: a.id, name: a.name, dir: appDir(a.id), running: (live.get(a.id) ?? a.state) === 'running'}))
		},
		// Stop or start an app around a backup or restore (the same path as its Stop and Start buttons).
		pauseForBackup: (id) => lifecycle(['stop'], 'stopping')({appId: id}),
		resumeAfterBackup: (id) => lifecycle(['up', '-d'], 'starting')({appId: id}),
		async usbBindings() {
			await ready
			const live = await liveStates().catch(() => new Map())
			return state.apps.map((a) => ({
				kind: 'app',
				id: a.id,
				name: a.name,
				devices: a.usbDevices ?? [],
				running: (live.get(a.id) ?? a.state) === 'running',
				liveIds: Array.isArray(a.usbApplied) && a.usbApplied.length && (a.usbDevices ?? []).every((d) => a.usbApplied.includes(d.id)) && a.usbApplied.length === (a.usbDevices ?? []).length ? a.usbApplied : [],
			}))
		},
		async bindUsb(id, rec) {
			await ready
			const app = findInstalled(id)
			if (app.system) throw new RpcError('PRECONDITION_FAILED', `${app.name} runs on the server itself, not in a container.`)
			if (!(app.usbDevices ?? []).some((d) => d.id === rec.id)) app.usbDevices = [...(app.usbDevices ?? []), rec]
			await save()
			return app
		},
		async unbindUsb(id, deviceId) {
			await ready
			const app = findInstalled(id)
			app.usbDevices = (app.usbDevices ?? []).filter((d) => d.id !== deviceId)
			await save()
			return app
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
					for (const a of plan) {
						const chosen = folderChoices(a.folders)
						const folderIds = chosen.map((f) => f.id)
						const folders = Object.fromEntries(chosen.map((f) => [f.id, join(home, f.suggest || f.id)]))
						for (const p of await permissionsOf({...a, folderIds, folders})) access.push({...p, appId: a.id, appName: a.name})
					}
					// System apps that need a one-time step from you first (see system-apps.mjs).
					const setup = []
					for (const a of plan) if (a.system && systemApps?.setup) { const s = await systemApps.setup(a.id); if (s) setup.push({...s, appId: a.id, appName: a.name}) }
					// Folders it lets you place: inside the app, or a folder of yours (suggested under your home).
					const folders = plan.flatMap((a) => (a.folders ?? []).map((f) => ({...f, appId: a.id, appName: a.name, suggest: f.suggest ? join(home, f.suggest) : null})))
					return {requiredFolders: [], gpuAccess: false, alsoInstalls: also, permissions: access, setup, folders, home}
				},
			},
			'apps.uninstall': {kind: 'mutation', run: uninstall},
			'apps.start': {kind: 'mutation', run: lifecycle(['up', '-d'], 'starting')},
			'apps.stop': {kind: 'mutation', run: lifecycle(['stop'], 'stopping')},
			'apps.restart': {kind: 'mutation', run: lifecycle(['restart'], 'restarting')},
			'apps.update': {kind: 'mutation', run: update},
			'apps.publish': {kind: 'mutation', run: publish},
			'apps.unpublish': {kind: 'mutation', run: unpublish},
			'apps.updates': {kind: 'query', run: updates},
			'apps.logs': {
				kind: 'query',
				run: async (input) => {
					const app = findInstalled(String(input?.appId ?? ''))
					const text = app.system ? await systemApps.logs(app) : await compose(app, 'logs', '--no-color', '--tail', '500')
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
			// Is the app's web page usable right now? (See readinessOf.) Open buttons wait on this.
			'apps.probe': {kind: 'query', run: async (input) => (await ready, probe(findInstalled(String(input?.appId ?? ''))))},
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
			'appStore.registry': {kind: 'query', run: async () => (await registry()).map(({url, meta, apps}) => ({url, meta, apps: apps.map(toList)}))},
			'appStore.app': {
				kind: 'query',
				run: async (input) => {
					const src = await findInRegistry(String(input?.appId ?? ''))
					if (!src) throw new RpcError('NOT_FOUND', 'That app isn’t in your stores')
					const a = toDetail(src)
					if (!Array.isArray(a.permissions)) a.permissions = (await permissionsOf(src)).map((p) => p.id)
					return a
				},
			},
			// "Check for new apps": download every store's latest listings now instead of waiting for the hourly check.
			'appStore.refresh': {kind: 'mutation', run: async () => ((await registry({refresh: true})).reduce((n, s) => n + s.apps.length, 0))},
			'appStore.repositories': {kind: 'query', run: async () => (await ready, state.stores.map(({url, meta, name}) => ({url, meta: meta ?? {id: url, name: name ?? url.split('/').pop()}})))},
			'appStore.addRepository': {
				kind: 'mutation',
				run: async (input) => {
					await ready
					const localDefault = defaultStores.find((d) => /^file:\/\//.test(d.url))
					let url = normalize(input?.url)
					if (localDefault && isGithubAppStore(url)) url = normalize(localDefault.url)
					checkUrl(url)
					return lock(`store:${url.toLowerCase()}`, async () => {
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
						dropRegistry()
						await save()
						return true
					})
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
					dropRegistry()
					await save()
					return true
				},
			},
		},
	}
}
