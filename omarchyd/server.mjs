// omarchyd: the Omarchy Server backend. It listens on localhost only; the Touch web server in front
// of it is the one thing that faces the network. Runs as the owner's own user, not root.
import {readFile, realpath} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import http from 'node:http'
import {fileURLToPath} from 'node:url'
import net from 'node:net'
import os from 'node:os'
import {extname, join} from 'node:path'

import {openAccounts} from './accounts.mjs'
import {APP_COOKIE, createApps} from './apps.mjs'
import {createFiles} from './files.mjs'
import {createMachines} from './machines.mjs'
import {createOmarchyTheme} from './omarchy-theme.mjs'
import {createStorage} from './storage.mjs'
import {bridge, openShell} from './terminal.mjs'
import {createUpdater} from './updater.mjs'
import {RpcError, handleRpc, sendError, sendJson} from './rpc.mjs'
import * as system from './system.mjs'
import {WebSocketServer} from 'ws'

export const OMARCHYD_VERSION = '0.8.1'

export async function startOmarchyd({port = 2021, host = '127.0.0.1', dataDir, home = os.homedir(), webPort = 7780, machineOptions = {}, appOptions = {}, storageOptions = {}, updaterOptions = {}, desktopVncPort = 5900}) {
	const accounts = await openAccounts(dataDir)
	const files = createFiles({home, dataDir})
	const machines = createMachines({dataDir, files, ...machineOptions})
	const storage = createStorage({dataDir, home, files, ...storageOptions})
	const updater = createUpdater({appDir: fileURLToPath(new URL('..', import.meta.url)), dataDir, currentVersion: OMARCHYD_VERSION, ...updaterOptions})
	const apps = createApps({dataDir, home, webPort, firewall: storage.firewall, ...appOptions})
	// Console tickets: single-use, 30 seconds, for the WebSocket bridge (same contract as before).
	const tickets = new Map()
	const release = await system.osRelease()
	const settings = {hostname: os.hostname()}

	const procedures = {
		// ---- who's here -----------------------------------------------------------------------
		'system.version': {kind: 'query', public: true, run: () => ({version: OMARCHYD_VERSION, name: `Omarchy Server ${OMARCHYD_VERSION}`})},
		'system.discoveryInfo': {
			kind: 'query',
			public: true,
			run: async () => ({id: 'omarchy-server', device: await system.deviceName(), version: OMARCHYD_VERSION, onboarded: accounts.hasOwner()}),
		},
		'user.listAccounts': {kind: 'query', public: true, run: () => accounts.listAccounts().map((a) => ({...a, wallpaper: {id: '1'}}))},
		'user.loginNative': {kind: 'mutation', public: true, run: (input) => accounts.loginNative(input)},
		'user.refreshNativeAccess': {kind: 'mutation', public: true, run: (input) => accounts.refresh(input?.deviceToken)},
		'user.login': {
			kind: 'mutation',
			public: true,
			run: async (input, {res}) => {
				const {bearer, cookie, userId} = await accounts.loginBrowser(input)
				await apps.ready
				res.setHeader('set-cookie', [`OMARCHY_BROWSER_SESSION=${cookie}; Path=/; HttpOnly; SameSite=Strict`, apps.sessionCookie(apps.issueSession(userId))])
				return bearer
			},
		},
		'user.renewToken': {kind: 'mutation', run: async (_i, {auth}) => (auth.kind === 'browser' && (await accounts.renewBrowser(auth.bearer)), 'renewed')},
		'user.logout': {kind: 'mutation', run: async (_i, {auth}) => (await accounts.logout(auth), true)},
		'user.get': {kind: 'query', run: (_i, {auth}) => ({...accounts.getUser(auth.userId), wallpaper: {id: '1'}, sambaUsername: os.userInfo().username})},
		'user.set': {kind: 'mutation', run: async (input, {auth}) => (await accounts.updateUser(auth.userId, input), true)},
		'user.changePassword': {kind: 'mutation', run: async (input, {auth}) => (await accounts.setPassword(auth.userId, input ?? {}), true)},
		'user.getHttpApiToken': {kind: 'query', run: (_i, {auth}) => accounts.issueUrlToken(auth)},
		'user.createWebSocketTicket': {
			kind: 'mutation',
			run: (input, {auth}) => {
				if (input?.target !== 'machines' && input?.target !== 'terminal') throw new RpcError('BAD_REQUEST', 'Unknown console')
				const now = Date.now()
				for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t)
				const ticket = randomBytes(24).toString('base64url')
				tickets.set(ticket, {userId: auth.userId, target: input.target, expires: now + 30_000})
				return ticket
			},
		},

		// ---- system ---------------------------------------------------------------------------
		'system.uptime': {kind: 'query', run: () => Math.round(os.uptime())},
		'system.cpuUsage': {kind: 'query', run: () => system.cpuUsage()},
		'system.memoryUsage': {kind: 'query', run: () => system.memoryUsage()},
		'system.diskUsage': {kind: 'query', run: () => system.diskUsage(home)},
		'system.cpuTemperature': {kind: 'query', run: () => system.cpuTemperature()},
		'system.getHostname': {kind: 'query', run: () => settings.hostname},
		'system.getIpAddresses': {kind: 'query', run: () => system.ipAddresses()},
		'system.device': {kind: 'query', run: async () => ({device: await system.deviceName(), os: release.pretty})},

		// ---- not built yet: answer empty so the web app shows empty states, not errors ----------
		'notifications.get': {kind: 'query', run: () => []},
		'wifi.connected': {kind: 'query', run: () => ({status: 'disconnected'})},
		'wifi.networks': {kind: 'query', run: () => []},

		...files.procedures,
		...storage.procedures,
		...machines.procedures,
		...apps.procedures,
		...updater.procedures,
		'apps.getTorEnabled': {kind: 'query', run: () => false},
	}

	const omarchyTheme = createOmarchyTheme({home})
	// The web app's wallpaper is the current Omarchy theme background.
	async function wallpaper(res) {
		for (const p of [join(home, '.config/omarchy/current/background'), join(home, '.config/omarchy/current/theme/backgrounds')]) {
			try {
				const real = await realpath(p)
				const type = {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}[extname(real).toLowerCase()]
				if (!type) continue
				const data = await readFile(real)
				res.writeHead(200, {'content-type': type, 'content-length': data.length, 'cache-control': 'no-cache'})
				return res.end(data)
			} catch {}
		}
		res.writeHead(404)
		res.end()
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		try {
			if (url.pathname.startsWith('/trpc/')) return await handleRpc(req, res, url, procedures, (r) => accounts.authenticate(r))
			if (url.pathname === '/assets/wallpapers/1.jpg' && req.method === 'GET') return await wallpaper(res)
			// Omarchy's themes and their backgrounds (local only; the web app proxies them).
			if (url.pathname === '/omarchy/themes' && req.method === 'GET') return sendJson(res, 200, await omarchyTheme.list())
			const bg = /^\/omarchy\/background\/(current|[0-9a-f]{16})$/.exec(url.pathname)
			if (bg && req.method === 'GET') return await omarchyTheme.serve(bg[1], res)
			// The web app asks whether a browser's app session is valid (it never sees it otherwise).
			if (url.pathname === '/app-auth/v1/account/session' && req.method === 'GET') {
				await apps.ready
				const cookie = Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).map(([k, ...v]) => [k, v.join('=')]))[APP_COOKIE]
				return sendJson(res, apps.checkSession(decodeURIComponent(cookie ?? '')) ? 200 : 401, {})
			}
			const fileKind = /^\/api\/files\/(view|download|upload)$/.exec(url.pathname)?.[1]
			if (fileKind === 'upload' && req.method === 'POST') {
				const auth = accounts.authenticate(req)
				if (!auth || auth.kind !== 'browser') return sendJson(res, 401, {error: 'unauthorized'})
				return await files.upload(req, res, url)
			}
			if ((fileKind === 'view' || fileKind === 'download') && req.method === 'GET') {
				if (!accounts.checkUrlToken(url.searchParams.get('token'), req)) return sendJson(res, 401, {error: 'unauthorized'})
				return await files.serveFile(req, res, url, fileKind)
			}
			sendJson(res, 404, {error: 'not found'})
		} catch (error) {
			if (!res.headersSent) sendError(res, error)
			else res.destroy()
		}
	})
	// VM screens: /machines/console?machineId=…&ticket=… (subprotocol "binary") <-> the machine's
	// VNC unix socket. Only reachable on localhost, and only with a fresh ticket.
	const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024})
	server.on('upgrade', async (req, socket, head) => {
		const refuse = (status) => {
			socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
			socket.destroy()
		}
		try {
			const url = new URL(req.url ?? '/', 'http://localhost')
			const route = {'/machines/console': 'machines', '/terminal': 'terminal'}[url.pathname]
			if (!route) return refuse('404 Not Found')
			const t = tickets.get(url.searchParams.get('ticket') ?? '')
			tickets.delete(url.searchParams.get('ticket') ?? '')
			if (!t || t.expires < Date.now() || t.target !== route) return refuse('401 Unauthorized')
			// A shell: your own, or one inside an installed app's container.
			if (route === 'terminal') {
				const cols = Number(url.searchParams.get('cols'))
				const rows = Number(url.searchParams.get('rows'))
				if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 4 || rows > 300) return refuse('400 Bad Request')
				const appId = url.searchParams.get('appId')
				const inApp = appId ? await apps.shellFor(appId).catch(() => null) : null
				if (appId && !inApp) return refuse('409 Conflict')
				const child = openShell({cols, rows, home, ...(inApp ?? {}), cwd: inApp?.cwd ?? home})
				wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, child))
				return
			}
			// "desktop" is this server's own Omarchy desktop, shared by wayvnc on 127.0.0.1 only.
			const machineId = url.searchParams.get('machineId') ?? ''
			const target = machineId === 'desktop' ? {host: '127.0.0.1', port: desktopVncPort} : await machines.vncSocket(machineId).then((path) => ({path}), () => null)
			if (!target) return refuse('409 Conflict')
			const vnc = net.connect(target)
			vnc.once('error', () => refuse('502 Bad Gateway'))
			vnc.once('connect', () => {
				vnc.removeAllListeners('error')
				wss.handleUpgrade(req, socket, head, (ws) => {
					vnc.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d, {binary: true}))
					ws.on('message', (d) => vnc.write(d))
					vnc.on('close', () => ws.close(1000))
					vnc.on('error', () => ws.terminate())
					ws.on('close', () => vnc.destroy())
					ws.on('error', () => vnc.destroy())
				})
			})
		} catch {
			refuse('500 Internal Server Error')
		}
	})
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, resolve)
	})
	return {url: `http://${host}:${server.address().port}`, accounts, close: () => (apps.close(), new Promise((r) => server.close(r)))}
}
