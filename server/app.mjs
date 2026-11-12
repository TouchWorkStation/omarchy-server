import http from 'node:http'
// UmbrelOS Touch server: a same-origin backend for the PWA.
//
// Why it exists: umbreld's browser login binds its token to an HttpOnly cookie on
// umbreld's own origin and sends no CORS headers, so a separately hosted page
// cannot call it from the browser. umbreld's *native* login (user.loginNative,
// the path Umbrel's own iOS/macOS apps use) returns bearer credentials instead.
// This server performs that login, keeps the credentials server-side, refreshes
// the 1-hour access token, and forwards only an explicit allowlist of calls.
// The phone only ever holds an opaque HttpOnly cookie for this server.

import {randomBytes, randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import express from 'express'
import WebSocket, {WebSocketServer} from 'ws'

import {createUmbrelClient, UmbrelError} from './umbrel.mjs'
import {hashId, newSessionId} from './store.mjs'

export const VERSION = '0.15.1'
const COOKIE = 'umbrel_touch_sid'
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365
const REFRESH_MARGIN_MS = 2 * 60 * 1000

// Every umbreld procedure the UI may reach, with its tRPC kind. Anything else
// (factory reset, password changes, repositories, network config…) is refused.
export const ALLOWED = {
	'system.version': 'query',
	'system.status': 'query',
	'system.uptime': 'query',
	'system.deviceName': 'query',
	'system.cpuTemperature': 'query',
	'system.cpuUsage': 'query',
	'system.memoryUsage': 'query',
	'system.diskUsage': 'query',
	'system.getIpAddresses': 'query',
	'system.checkUpdate': 'query',
	'user.get': 'query',
	'apps.list': 'query',
	'apps.state': 'query',
	'apps.details': 'query',
	'apps.updates': 'query',
	'apps.recentlyOpened': 'query',
	'apps.logs': 'query',
	'apps.installReview': 'query',
	'appStore.registry': 'query',
	'appStore.repositories': 'query',
	'machines.list': 'query',
	'notifications.get': 'query',
	'apps.start': 'mutation',
	'apps.stop': 'mutation',
	'apps.restart': 'mutation',
	'apps.update': 'mutation',
	'apps.install': 'mutation',
	'appStore.addRepository': 'mutation',
	'appStore.removeRepository': 'mutation',
	'apps.uninstall': 'mutation',
	'apps.trackOpen': 'mutation',
	'machines.start': 'mutation',
	'machines.stop': 'mutation',
	'machines.restart': 'mutation',
	'machines.forceStop': 'mutation',
	'notifications.clear': 'mutation',
	'system.restart': 'mutation',
	'system.shutdown': 'mutation',
	// Create a machine
	'machines.capabilities': 'query',
	'machines.osImages': 'query',
	'machines.create': 'mutation',
	'machines.uninstall': 'mutation',
	// Settings: account
	'user.set': 'mutation',
	'user.changePassword': 'mutation',
	'user.is2faEnabled': 'query',
	'user.generateTotpUri': 'query',
	'user.enable2fa': 'mutation',
	'user.disable2fa': 'mutation',
	'user.listSessions': 'query',
	'user.revokeSession': 'mutation',
	'user.revokeOtherSessions': 'mutation',
	// Settings: software update
	'system.updateStatus': 'query',
	'system.update': 'mutation',
	'system.getReleaseChannel': 'query',
	'system.setReleaseChannel': 'mutation',
	// Settings: network & privacy
	'system.getHostname': 'query',
	'system.setHostname': 'mutation',
	'system.isExternalDns': 'query',
	'system.setExternalDns': 'mutation',
	'apps.getTorEnabled': 'query',
	'apps.setTorEnabled': 'mutation',
	'wifi.supported': 'query',
	'wifi.networks': 'query',
	'wifi.connected': 'query',
	'wifi.connect': 'mutation',
	'wifi.disconnect': 'mutation',
	// Settings: advanced (umbreld itself re-checks the password for factory reset)
	'system.logs': 'query',
	'system.factoryReset': 'mutation',
	// Files (NAS)
	'files.list': 'query',
	'files.search': 'query',
	'files.recents': 'query',
	'files.favorites': 'query',
	'files.addFavorite': 'mutation',
	'files.removeFavorite': 'mutation',
	'files.createDirectory': 'mutation',
	'files.rename': 'mutation',
	'files.copy': 'mutation',
	'files.move': 'mutation',
	'files.trash': 'mutation',
	'files.restore': 'mutation',
	'files.delete': 'mutation',
	'files.emptyTrash': 'mutation',
	'files.operationProgress': 'query',
	'files.shares': 'query',
	'files.addShare': 'mutation',
	'files.removeShare': 'mutation',
	'files.sharePassword': 'query',
	'files.externalDevices': 'query',
	'files.unmountExternalDevice': 'mutation',
	'files.getThumbnail': 'mutation',
	'files.unarchive': 'mutation',
	// Storage: the same calls umbrelOS's Storage Manager makes. hardware.raid.setup is
	// deliberately absent: umbreld marks it dev-only, and on a running Umbrel it writes a RAID
	// config the next boot mounts as the data drive, i.e. an empty pool in place of your data.
	'hardware.internalStorage.getDevices': 'query',
	'hardware.raid.getStatus': 'query',
	'hardware.raid.addDevice': 'mutation',
	'hardware.raid.addMirror': 'mutation',
	'hardware.raid.addAccelerator': 'mutation',
	'hardware.raid.replaceDevice': 'mutation',
	'hardware.raid.transitionToFailsafeRaidz': 'mutation',
	'hardware.raid.scrub': 'mutation',
}

// Long-running mutations: umbreld answers when the operation finishes.
const SLOW = new Set(['files.copy', 'files.unarchive', 'files.getThumbnail', 'files.move', 'files.delete', 'files.emptyTrash', 'files.search', 'files.list', 'apps.install', 'apps.update', 'apps.uninstall', 'appStore.registry', 'appStore.addRepository', 'apps.logs', 'system.update', 'system.logs', 'machines.create', 'machines.uninstall', 'wifi.connect', 'wifi.networks', 'system.setHostname', 'hardware.internalStorage.getDevices', 'hardware.raid.addDevice', 'hardware.raid.addMirror', 'hardware.raid.addAccelerator', 'hardware.raid.replaceDevice', 'hardware.raid.transitionToFailsafeRaidz'])

function parseCookies(header = '') {
	const out = {}
	for (const part of header.split(';')) {
		const i = part.indexOf('=')
		if (i <= 0) continue
		// Self-hosted apps on the same host share its cookies; a malformed one must not break us.
		const raw = part.slice(i + 1).trim()
		try {
			out[part.slice(0, i).trim()] = decodeURIComponent(raw)
		} catch {
			out[part.slice(0, i).trim()] = raw
		}
	}
	return out
}

function nativeClientFor(userAgent = '') {
	const ua = userAgent.toLowerCase()
	const deviceClass = /ipad|tablet/.test(ua) ? 'tablet' : /iphone|android|mobile/.test(ua) ? 'phone' : 'desktop'
	const platform = /iphone|ipad|ios/.test(ua)
		? 'ios'
		: /android/.test(ua)
			? 'android'
			: /windows/.test(ua)
				? 'windows'
				: /mac os/.test(ua)
					? 'macos'
					: 'web'
	return {id: 'umbrel-touch', platform, deviceClass, appVersion: VERSION, appBuild: '1', osVersion: 'web'}
}

// umbreld returns {id, brandColorHsl} (e.g. "259 100% 59%"); pass through only safe values.
export function wallpaperOf(w) {
	if (!w || typeof w !== 'object') return null
	const id = /^\d{1,3}$/.test(String(w.id)) ? String(w.id) : null
	const brand = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(String(w.brandColorHsl)) ? String(w.brandColorHsl) : null
	return id ? {id, brandColorHsl: brand} : null
}

const isLoopback = (hostname) => hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname)

export function normalizeUmbrelUrl(input) {
	let value = String(input ?? '').trim()
	if (!value) throw new Error('Enter your Umbrel’s address')
	if (!/^https?:\/\//i.test(value)) value = `http://${value}`
	const url = new URL(value)
	if (url.username || url.password) throw new Error('The address must not contain a username or password')
	return `${url.protocol}//${url.host}`
}

export function createApp({store, staticDir, fetchImpl = fetch, secureCookies = false, relayPortBase = Number(process.env.TOUCH_APP_PORT_BASE ?? 7800), relayHost = process.env.HOST ?? '0.0.0.0'}) {
	const app = express()
	app.disable('x-powered-by')
	app.set('trust proxy', 'loopback')

	let client = null
	const getClient = () => {
		const {umbrelUrl} = store.getConfig()
		if (!umbrelUrl) return null
		if (!client || client.baseUrl !== umbrelUrl) client = createUmbrelClient({baseUrl: umbrelUrl, fetchImpl})
		return client
	}

	// Desktop mode opens Umbrel apps in windows, i.e. frames of http(s)://<umbrel host>:<app port>.
	// Allow exactly that host (any port) and nothing else. The Host header is client-controlled,
	// so only a plain hostname or IP makes it into the policy.
	const frameHost = (req) => {
		const c = getClient()
		if (!c) return null
		const upstream = new URL(c.baseUrl).hostname
		const host = isLoopback(upstream) ? req.hostname : upstream
		return /^[a-z0-9.-]{1,253}$/i.test(host ?? '') ? host : null
	}
	// App subdomains (TOUCH_APP_HOSTS) are routed to their relay before Touch's own handling.
	let hostRoute = null
	let appHostFrameSrc = () => ''
	app.use((req, res, next) => (hostRoute ? hostRoute(req, res, next).catch(next) : next()))
	app.use((req, res, next) => {
		const fh = frameHost(req)
		const sub = appHostFrameSrc()
		const frameSrc = fh ? `frame-src 'self' http://${fh}:* https://${fh}:*${sub ? ` ${sub}` : ''}; ` : ''
		res.set({
			'Content-Security-Policy': `default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: wss:; ${frameSrc}frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		})
		next()
	})

	const api = express.Router()
	api.use(express.json({limit: '64kb'}))
	api.use((req, res, next) => {
		res.set('Cache-Control', 'no-store')
		req.sid = parseCookies(req.headers.cookie)[COOKIE]
		// CSRF: state-changing calls must come from our own page.
		if (req.method !== 'GET') {
			const origin = req.headers.origin
			if (req.headers['x-umbrel-touch'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) {
				return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Cross-site request refused'}})
			}
		}
		next()
	})

	const sendError = (res, error) => {
		if (error instanceof UmbrelError) {
			return res.status(error.status >= 400 ? error.status : 502).json({error: {code: error.code, message: error.message}})
		}
		console.error('[umbrel-touch]', error)
		return res.status(500).json({error: {code: 'INTERNAL', message: 'Something went wrong in UmbrelOS Touch'}})
	}

	// Secure when asked for, or when the request arrived over HTTPS (e.g. through a Cloudflare
	// Tunnel or reverse proxy on this machine, which is the only proxy we trust headers from).
	const setCookie = (res, value, maxAge) =>
		res.append(
			'Set-Cookie',
			`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies || res.req?.secure ? '; Secure' : ''}`,
		)

	// ---- Credentials -------------------------------------------------------
	const refreshing = new Map()
	async function accessTokenFor(sid, session, {force = false} = {}) {
		if (session.mode === 'legacy') return session.accessToken
		if (!force && session.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken
		if (!refreshing.has(sid)) {
			const run = (async () => {
				const result = await getClient().mutation('user.refreshNativeAccess', {
					deviceToken: session.deviceToken,
					client: session.client,
				})
				await store.updateSession(sid, {
					accessToken: result.accessToken,
					accessExpiresAt: result.accessExpiresAt,
					lastSeenAt: Date.now(),
				})
				return result.accessToken
			})().finally(() => refreshing.delete(sid))
			refreshing.set(sid, run)
		}
		return refreshing.get(sid)
	}

	async function authedCall(req, path, kind, input) {
		const umbrel = getClient()
		if (!umbrel) throw new UmbrelError('UmbrelOS Touch is not connected to an Umbrel yet', {code: 'NOT_CONFIGURED', status: 409})
		const session = store.getSession(req.sid)
		if (!session) throw new UmbrelError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		const timeout = SLOW.has(path) ? 30 * 60 * 1000 : 20_000
		const run = async (token) =>
			kind === 'mutation' ? umbrel.mutation(path, input, {token, timeout}) : umbrel.query(path, input, {token, timeout})
		try {
			return await run(await accessTokenFor(req.sid, session))
		} catch (error) {
			if (!(error instanceof UmbrelError) || error.code !== 'UNAUTHORIZED') throw error
			if (session.mode === 'legacy') {
				await store.deleteSession(req.sid)
				throw error
			}
			// The access token may have been revoked or expired early: refresh once and retry.
			let token
			try {
				token = await accessTokenFor(req.sid, store.getSession(req.sid) ?? session, {force: true})
			} catch (refreshError) {
				if (refreshError instanceof UmbrelError && refreshError.code === 'UNAUTHORIZED') {
					await store.deleteSession(req.sid) // session revoked in umbrelOS Settings
				}
				throw refreshError
			}
			return run(token)
		}
	}

	// ---- Bootstrap / setup ---------------------------------------------------
	api.get('/bootstrap', async (req, res) => {
		const umbrel = getClient()
		const session = store.getSession(req.sid)
		const out = {
			touch: {version: VERSION},
			configured: !!umbrel,
			umbrel: null,
			accounts: [],
			session: session ? {accountId: session.accountId, mode: session.mode, console: !!session.console} : null,
		}
		if (!umbrel) return res.json(out)
		// When Touch runs on the Umbrel itself it talks to 127.0.0.1; the phone must
		// use the address it reached us on instead.
		const upstream = new URL(umbrel.baseUrl)
		const local = isLoopback(upstream.hostname)
		const host = local ? req.hostname : upstream.hostname
		const publicUrl = local ? `http://${req.hostname}` : umbrel.baseUrl
		try {
			const [version, discovery, accounts] = await Promise.all([
				umbrel.query('system.version'),
				umbrel.query('system.discoveryInfo').catch(() => null),
				umbrel.query('user.listAccounts').catch(() => []),
			])
			out.umbrel = {
				url: publicUrl,
				host,
				reachable: true,
				version: version?.version,
				name: version?.name,
				device: discovery?.device ?? null,
				onboarded: discovery?.onboarded ?? true,
			}
			const mapped = (accounts ?? []).map((a) => ({
				userId: a.userId,
				name: a.name,
				avatar: a.avatarUrl?.startsWith('/api/accounts/') ? `/api/umbrel-avatar?path=${encodeURIComponent(a.avatarUrl)}` : null,
				wallpaper: wallpaperOf(a.wallpaper),
			}))
			// Before sign-in, say nothing about who has an account here: the sign-in page asks for
			// a username and a password. Only the wallpaper (for the backdrop) is shared.
			out.accounts = session ? mapped : mapped.slice(0, 1).map((a) => ({userId: '', name: '', avatar: null, wallpaper: a.wallpaper}))
		} catch (error) {
			out.umbrel = {url: publicUrl, host, reachable: false, error: error.message}
		}
		res.json(out)
	})

	api.post('/setup', async (req, res) => {
		const configured = !!store.getConfig().umbrelUrl
		// Repointing an already-configured server needs a signed-in session, so nobody
		// on the network can aim it at a look-alike to collect passwords.
		if (configured && !store.getSession(req.sid)) {
			return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Sign in first to change the Umbrel address'}})
		}
		let url
		try {
			url = normalizeUmbrelUrl(req.body?.url)
		} catch (error) {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: error.message}})
		}
		try {
			const probe = createUmbrelClient({baseUrl: url, fetchImpl, timeoutMs: 8000})
			const version = await probe.query('system.version')
			if (!version?.version) throw new UmbrelError('That address answered, but not like umbrelOS', {status: 502})
			if (configured && url !== store.getConfig().umbrelUrl) await store.clearSessions()
			await store.setConfig({umbrelUrl: url})
			res.json({ok: true, url, version: version.version, name: version.name})
		} catch (error) {
			sendError(res, error)
		}
	})

	// The account's own umbrelOS wallpaper, served from the user's Umbrel. umbrelOS
	// ships an AVIF and a JPEG of each; the id is validated so only those can be read.
	api.get('/umbrel-wallpaper/:id', async (req, res) => {
		const umbrel = getClient()
		const id = req.params.id
		if (!umbrel || !/^\d{1,3}$/.test(id)) return res.status(404).end()
		const tier = req.query.size === 'thumb' ? 'thumbnails' : 'medium'
		for (const [path, type] of [
			[`/assets/wallpapers/generated-avif/${tier}/${id}.avif`, 'image/avif'],
			[`/assets/wallpapers/${id}.jpg`, 'image/jpeg'],
		]) {
			try {
				const upstream = await fetchImpl(`${umbrel.baseUrl}${path}`, {signal: AbortSignal.timeout(10_000)})
				if (!upstream.ok || !(upstream.headers.get('content-type') ?? '').startsWith('image/')) continue
				res.set({'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable'})
				return res.send(Buffer.from(await upstream.arrayBuffer()))
			} catch {
				/* try the next format */
			}
		}
		res.status(404).end()
	})

	api.get('/umbrel-avatar', async (req, res) => {
		const umbrel = getClient()
		const path = String(req.query.path ?? '')
		if (!umbrel || !/^\/api\/accounts\/[\w.\-/]+$/.test(path) || path.includes('..')) return res.status(404).end()
		try {
			const upstream = await fetchImpl(`${umbrel.baseUrl}${path}`, {signal: AbortSignal.timeout(8000)})
			if (!upstream.ok) return res.status(404).end()
			const type = upstream.headers.get('content-type') ?? ''
			if (!type.startsWith('image/')) return res.status(404).end()
			res.set({'Content-Type': type, 'Cache-Control': 'private, max-age=86400'})
			res.send(Buffer.from(await upstream.arrayBuffer()))
		} catch {
			res.status(404).end()
		}
	})

	// ---- Auth ----------------------------------------------------------------
	const attempts = new Map()
	api.post('/auth/login', async (req, res) => {
		const umbrel = getClient()
		if (!umbrel) return res.status(409).json({error: {code: 'NOT_CONFIGURED', message: 'Connect to your Umbrel first'}})
		const ip = req.ip ?? 'unknown'
		const now = Date.now()
		const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 5 * 60 * 1000)
		if (recent.length >= 10) {
			return res.status(429).json({error: {code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Wait a few minutes.'}})
		}
		attempts.set(ip, [...recent, now])

		const {password, totpToken, username} = req.body ?? {}
		if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Enter your username and password'}})
		}
		// Every sign-in needs the account's name and its password. The name is matched here, on
		// the server, and a wrong name and a wrong password give the same answer.
		const WRONG = {error: {code: 'UNAUTHORIZED', message: 'Incorrect username or password'}}
		const known = await umbrel.query('user.listAccounts').catch(() => null)
		let userId
		if (Array.isArray(known) && known.length) {
			const wanted = username.trim().toLowerCase()
			const match = known.find((a) => typeof a.name === 'string' && a.name.trim().toLowerCase() === wanted)
			if (!match) {
				await new Promise((r) => setTimeout(r, 400 + Math.random() * 300))
				return res.status(401).json(WRONG)
			}
			userId = match.userId
		}
		const userAgent = req.headers['user-agent']
		const nativeClient = nativeClientFor(userAgent)
		const credentials = {password, ...(totpToken ? {totpToken: String(totpToken)} : {}), ...(userId ? {userId} : {})}
		let session
		try {
			const result = await umbrel.mutation('user.loginNative', {...credentials, client: nativeClient}, {userAgent})
			session = {
				mode: 'native',
				accountId: result.accountId,
				accessToken: result.accessToken,
				accessExpiresAt: result.accessExpiresAt,
				deviceToken: result.deviceToken,
				client: nativeClient,
			}
		} catch (error) {
			// umbrelOS before 2.0 has no native login; its user.login returns a bearer JWT.
			if (error instanceof UmbrelError && /incorrect password/i.test(error.message)) return res.status(401).json(WRONG)
			if (!(error instanceof UmbrelError) || error.code !== 'NOT_FOUND') return sendError(res, error)
			try {
				const token = await umbrel.mutation('user.login', credentials, {userAgent})
				if (typeof token !== 'string') throw new UmbrelError('Unsupported umbrelOS version', {status: 502})
				session = {mode: 'legacy', accountId: userId ?? 'owner', accessToken: token}
			} catch (legacyError) {
				if (legacyError instanceof UmbrelError && /incorrect password/i.test(legacyError.message)) return res.status(401).json(WRONG)
				return sendError(res, legacyError)
			}
		}
		// The VM console needs a WebSocket ticket, which umbreld only issues to browser
		// sessions (not native ones). Hold a second, browser-style session server-side
		// for that single purpose. Failing to get one only disables the console.
		if (session.mode === 'native') {
			session.console = await openConsoleSession(umbrel, credentials, userAgent).catch(() => null)
		}
		attempts.delete(ip)
		const sid = newSessionId()
		await store.putSession(sid, {...session, createdAt: now, lastSeenAt: now, userAgent: String(userAgent ?? '').slice(0, 200)})
		setCookie(res, sid, SESSION_MAX_AGE_S)
		res.json({ok: true, accountId: session.accountId, mode: session.mode})
	})

	api.post('/auth/logout', async (req, res) => {
		const session = store.getSession(req.sid)
		if (session?.console) {
			await getClient()
				?.mutation('user.logout', undefined, {token: session.console.token, cookie: session.console.cookie})
				.catch(() => {})
		}
		if (session) {
			// Revoke the umbrelOS session too, so it disappears from Settings › Devices.
			await authedCall(req, 'user.logout', 'mutation').catch(() => {})
			await store.deleteSession(req.sid)
		}
		setCookie(res, '', 0)
		res.json({ok: true})
	})

	// ---- Saved appearance (per umbrelOS account, shared by all its phones) -------
	const THEME_IDS = ['umbrel', 'mocha', 'tokyo', 'gruvbox', 'latte', 'custom', 'omarchy']
	const ACCENT_IDS = ['wallpaper', 'blue', 'mauve', 'teal', 'peach', 'green', 'pink']
	const HSL = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/
	const accountKey = (accountId) => hashId(`account:${accountId}`).slice(0, 32)
	const backgroundFile = (accountId) => join(store.dataDir, 'backgrounds', `${accountKey(accountId)}.jpg`)
	const prefsOf = (accountId) => store.getConfig().prefs?.[accountKey(accountId)] ?? null
	const savePrefs = async (accountId, patch) => {
		const all = {...(store.getConfig().prefs ?? {})}
		all[accountKey(accountId)] = {...(all[accountKey(accountId)] ?? {}), ...patch}
		await store.setConfig({prefs: all})
		return all[accountKey(accountId)]
	}
	const requireSession = (req, res) => {
		const session = store.getSession(req.sid)
		if (!session) res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
		return session
	}

	api.get('/prefs', (req, res) => {
		const session = requireSession(req, res)
		if (session) res.json({prefs: prefsOf(session.accountId)})
	})
	api.post('/prefs', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const {theme, accent, customBrandHsl} = req.body ?? {}
		const patch = {}
		if (theme !== undefined) {
			if (!THEME_IDS.includes(theme)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown theme'}})
			patch.theme = theme
		}
		if (accent !== undefined) {
			if (!ACCENT_IDS.includes(accent)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown accent'}})
			patch.accent = accent
		}
		if (customBrandHsl !== undefined) {
			if (customBrandHsl !== null && !HSL.test(String(customBrandHsl))) {
				return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad colour'}})
			}
			patch.customBrandHsl = customBrandHsl
		}
		res.json({prefs: await savePrefs(session.accountId, patch)})
	})

	// Custom background: the phone resizes the photo to a JPEG before sending it.
	api.post('/background', express.raw({type: 'image/jpeg', limit: '8mb'}), async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const body = req.body
		const isJpeg = Buffer.isBuffer(body) && body.length > 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
		if (!isJpeg) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'That image couldn’t be read. Try a JPEG or PNG.'}})
		await mkdir(join(store.dataDir, 'backgrounds'), {recursive: true, mode: 0o700})
		await writeFile(backgroundFile(session.accountId), body, {mode: 0o600})
		const prefs = await savePrefs(session.accountId, {backgroundVersion: Date.now()})
		res.json({prefs})
	})
	api.get('/background', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		try {
			const data = await readFile(backgroundFile(session.accountId))
			res.set({'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable'}).send(data)
		} catch {
			res.status(404).end()
		}
	})
	api.delete('/background', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		await rm(backgroundFile(session.accountId), {force: true})
		const current = prefsOf(session.accountId) ?? {}
		const prefs = await savePrefs(session.accountId, {
			backgroundVersion: null,
			customBrandHsl: null,
			...(current.theme === 'custom' ? {theme: 'umbrel'} : {}),
		})
		res.json({prefs})
	})

	// ---- VM console ------------------------------------------------------------
	async function openConsoleSession(umbrel, credentials, userAgent) {
		const {data: token, cookies} = await umbrel.mutation('user.login', credentials, {userAgent, withCookies: true})
		const cookie = cookies.filter((c) => /BROWSER_SESSION/.test(c)).join('; ')
		if (typeof token !== 'string' || !cookie) return null
		// The same login also returns umbrelOS's app-gateway session (UMBREL_APP_SESSION). Touch
		// keeps it server-side so app windows open without umbrelOS's separate app sign-in.
		const appCookie = cookies.find((c) => /^UMBREL_APP_SESSION=/.test(c)) ?? null
		return {token, cookie, appCookie, renewedAt: Date.now()}
	}

	// The server-held browser-style session: dashboard token + browser cookie. umbreld
	// requires it for WebSocket tickets and the file HTTP API; native sessions can't use those.
	async function browserAuth(sid) {
		const umbrel = getClient()
		const session = store.getSession(sid)
		if (!umbrel || !session) throw new UmbrelError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		if (!session.console) {
			throw new UmbrelError('Sign out and back in to use this', {code: 'CONSOLE_SESSION_REQUIRED', status: 409})
		}
		const auth = {token: session.console.token, cookie: session.console.cookie}
		// Browser sessions last 7 days from their last renewal; keep ours fresh.
		if (Date.now() - session.console.renewedAt > 24 * 60 * 60 * 1000) {
			await umbrel.mutation('user.renewToken', undefined, auth).catch(() => {})
			await store.updateSession(sid, {console: {...session.console, renewedAt: Date.now()}})
		}
		return auth
	}
	const lostBrowserSession = async (sid, error) => {
		if (error instanceof UmbrelError && error.code === 'UNAUTHORIZED') {
			await store.updateSession(sid, {console: null})
			return new UmbrelError('Sign out and back in to use this', {code: 'CONSOLE_SESSION_REQUIRED', status: 409})
		}
		return error
	}

	async function consoleTicket(sid, target = 'machines') {
		const auth = await browserAuth(sid)
		try {
			return await getClient().mutation('user.createWebSocketTicket', {target}, auth)
		} catch (error) {
			throw await lostBrowserSession(sid, error)
		}
	}

	// ---- Files: downloads, previews, thumbnails and uploads ---------------------
	// umbreld serves file bytes over plain HTTP, authorised by the browser cookie plus
	// a session-wide URL token. We fetch both server-side and stream the bytes through.
	const urlTokens = new Map() // sid -> {token, at}
	async function fileUrlToken(sid) {
		const cached = urlTokens.get(sid)
		if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.token
		const auth = await browserAuth(sid)
		try {
			const token = await getClient().query('user.getHttpApiToken', undefined, auth)
			urlTokens.set(sid, {token, at: Date.now()})
			return token
		} catch (error) {
			throw await lostBrowserSession(sid, error)
		}
	}
	const PASS_HEADERS = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified', 'etag']
	const fileGet = (kind) => async (req, res) => {
		try {
			if (!store.getSession(req.sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
			const auth = await browserAuth(req.sid)
			const token = await fileUrlToken(req.sid)
			const url = new URL(`${getClient().baseUrl}/api/files/${kind}`)
			if (kind === 'thumbnail') {
				if (!/^[\w.-]{1,200}$/.test(req.params.name)) return res.status(404).end()
				url.pathname += `/${req.params.name}`
			}
			for (const p of [req.query.path].flat()) if (typeof p === 'string') url.searchParams.append('path', p)
			url.searchParams.set('token', token)
			const upstream = await fetchImpl(url, {
				headers: {cookie: auth.cookie, ...(req.headers.range ? {range: req.headers.range} : {}), ...(kind === 'view' && typeof req.headers.accept === 'string' ? {accept: req.headers.accept.slice(0, 300)} : {})},
				signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
			})
			if (upstream.status === 401) urlTokens.delete(req.sid)
			res.status(upstream.status)
			for (const h of PASS_HEADERS) {
				const v = upstream.headers.get(h)
				if (v) res.setHeader(h, v)
			}
			res.setHeader('Cache-Control', kind === 'thumbnail' ? 'private, max-age=3600' : 'private, no-store')
			res.setHeader('X-Content-Type-Options', 'nosniff')
			// Previews render inline but sandboxed, so a file can't script this app.
			if (kind === 'view') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
			if (!upstream.body) return res.end()
			const {Readable} = await import('node:stream')
			const body = Readable.fromWeb(upstream.body)
			req.on('close', () => body.destroy())
			body.on('error', () => res.destroy())
			body.pipe(res)
		} catch (error) {
			sendError(res, error)
		}
	}
	api.get('/files/download', fileGet('download'))
	api.get('/files/view', fileGet('view'))
	api.get('/files/thumbnail/:name', fileGet('thumbnail'))

	api.post('/files/upload', async (req, res) => {
		try {
			if (!store.getSession(req.sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
			const path = req.query.path
			if (typeof path !== 'string' || !path.startsWith('/')) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'path is required'}})
			const collision = ['error', 'keep-both', 'replace'].includes(req.query.collision) ? req.query.collision : 'keep-both'
			const auth = await browserAuth(req.sid)
			const url = new URL(`${getClient().baseUrl}/api/files/upload`)
			url.searchParams.set('path', path)
			url.searchParams.set('collision', collision)
			const {Readable} = await import('node:stream')
			const upstream = await fetchImpl(url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${auth.token}`,
					cookie: auth.cookie,
					'content-type': 'application/octet-stream',
					...(req.headers['content-length'] ? {'content-length': req.headers['content-length']} : {}),
				},
				body: Readable.toWeb(req),
				duplex: 'half',
				signal: AbortSignal.timeout(12 * 60 * 60 * 1000),
			})
			const text = await upstream.text()
			let body
			try {
				body = JSON.parse(text)
			} catch {
				body = {}
			}
			if (!upstream.ok) {
				const message = upstream.status === 507 ? 'Not enough free space on your Umbrel' : upstream.status === 409 ? 'A file with that name already exists' : (body.error ?? `Upload failed (HTTP ${upstream.status})`)
				return res.status(upstream.status === 401 ? 409 : upstream.status).json({error: {code: 'UPLOAD_FAILED', message}})
			}
			res.json({ok: true, path: body.path ?? path})
		} catch (error) {
			sendError(res, error)
		}
	})

	// Desktop app windows: is this browser signed in to umbrelOS's app gateway for this app?
	// umbrelOS protects every app with its own sign-in (port 2000, /app-auth), whose page refuses
	// to be shown inside another site's frame. The resulting session cookie is per host, not per
	// port, so the browser also sends it to Touch. We only ask umbrelOS whether it is valid for
	// the app (the same check umbrelOS's own sign-in page makes) and answer yes/no. The cookie
	// itself is never stored, logged or returned, and this can't sign anyone in.
	const APP_COOKIES = ['UMBREL_APP_SESSION', '__Host-UMBREL_APP_SESSION_HTTPS']
	api.get('/app-access', async (req, res) => {
		res.set('Cache-Control', 'no-store')
		if (!store.getSession(req.sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
		const appId = String(req.query.app ?? '')
		if (!/^[a-zA-Z0-9-]{1,100}$/.test(appId)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad app'}})
		const cookies = parseCookies(req.headers.cookie)
		const token = APP_COOKIES.map((n) => cookies[n]).find((v) => typeof v === 'string' && v.length > 0 && v.length < 4096)
		if (!token) return res.json({state: 'signin'})
		try {
			const url = new URL(`${getClient().baseUrl}/app-auth/v1/account/session`)
			url.search = new URLSearchParams({app: appId, origin: 'host', path: '/'}).toString()
			// umbreld is reached over plain HTTP here, so it reads the plain-HTTP cookie name.
			const r = await fetch(url, {headers: {cookie: `UMBREL_APP_SESSION=${encodeURIComponent(token)}`, accept: 'application/json'}, redirect: 'manual', signal: AbortSignal.timeout(8000)})
			await r.arrayBuffer().catch(() => {})
			res.json({state: r.status === 200 ? 'ok' : r.status === 401 ? 'signin' : r.status === 403 ? 'not-shared' : 'unknown'})
		} catch {
			res.json({state: 'unknown'})
		}
	})

	// Desktop: can each app be shown inside a window? Many apps (Forgejo, Nextcloud, Home
	// Assistant…) forbid being embedded in another site (X-Frame-Options / CSP frame-ancestors),
	// which browsers show as "refused to connect". We load each app's start page once, the way
	// the browser would (through umbrelOS's app gateway, with the browser's own app session,
	// which the gateway strips before the app sees it), and read only those headers.
	//   window: can be shown in a window · tab: must open in a browser tab
	//   signin: umbrelOS wants this browser to sign in first · unknown: couldn't tell
	const appFrameCache = new Map() // `${appId}:${signedIn}` -> {verdict, at}
	async function frameVerdict(app, umbrelHost, cookieHeader) {
		if (!app?.port) return 'unknown'
		if (app.requiresHttps) return 'tab'
		const origin = `http://${umbrelHost.includes(':') ? `[${umbrelHost}]` : umbrelHost}:${app.port}`
		let url = new URL(app.path || '/', origin)
		for (let hop = 0; hop < 5; hop++) {
			let r
			try {
				r = await fetch(url, {
					headers: {accept: 'text/html', ...(cookieHeader ? {cookie: cookieHeader} : {})},
					redirect: 'manual',
					signal: AbortSignal.timeout(6000),
				})
			} catch {
				return 'unknown'
			}
			r.body?.cancel().catch(() => {})
			if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
				const next = new URL(r.headers.get('location'), url)
				// Sent elsewhere (umbrelOS's sign-in on port 2000, or an old login page): sign in first.
				if (next.origin !== url.origin || next.pathname.startsWith('/app-auth')) return 'signin'
				url = next
				continue
			}
			const xfo = r.headers.get('x-frame-options')
			if (xfo && /deny|sameorigin|allow-from/i.test(xfo)) return 'blocked'
			const fa = /frame-ancestors([^;]*)/i.exec(r.headers.get('content-security-policy') ?? '')
			if (fa && !/(^|\s)\*(\s|$)/.test(fa[1])) return 'blocked'
			return r.status >= 500 ? 'unknown' : 'window'
		}
		return 'unknown'
	}
	// App relay. An app that forbids embedding can still get a desktop window: Touch relays it
	// on a port of its own and swaps the app's "nobody may embed me" header for "only UmbrelOS
	// Touch may embed me". Everything else passes through untouched, including umbrelOS's app
	// gateway, so umbrelOS still checks its own sign-in on every request. On top of that the
	// relay only answers browsers signed in to Touch, and never passes Touch's cookie to the app.
	const relays = new Map() // appId -> {port, targetPort, server, ancestors}
	const PING_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
	// Who is this? A relay request carries either Touch's own cookie (relay ports share the host,
	// and cookies ignore ports) or, on an app subdomain, the per-app cookie from /__touch/enter.
	const APP_COOKIE = '__touch_app'
	const appSessions = new Map() // id -> {sid, appId, exp}
	const appTickets = new Map() // ticket -> {sid, appId, exp}
	const relaySid = (req, appId) => {
		const cookies = parseCookies(req.headers.cookie)
		if (store.getSession(cookies[COOKIE])) return cookies[COOKIE]
		const a = appSessions.get(cookies[APP_COOKIE])
		if (a && a.appId === appId && a.exp > Date.now() && store.getSession(a.sid)) return a.sid
		return null
	}
	const relayHeaders = (req, sid) => {
		const h = {...req.headers}
		for (const k of Object.keys(h)) if (k.startsWith('x-forwarded-') || k === 'forwarded' || k.startsWith('cf-')) delete h[k]
		const held = store.getSession(sid)?.console?.appCookie
		const rest = (h.cookie ?? '')
			.split(';')
			.map((c) => c.trim())
			.filter((c) => {
				const name = c.slice(0, c.indexOf('='))
				// Touch's cookies never reach the app; Touch's own umbrelOS app session wins.
				return c && name !== COOKIE && name !== APP_COOKIE && !(held && name === 'UMBREL_APP_SESSION')
			})
		if (held) rest.push(held)
		if (rest.length) h.cookie = rest.join('; ')
		else delete h.cookie
		return h
	}
	// "Only Touch may embed me": drop X-Frame-Options and any frame-ancestors, add ours.
	const frameHeaders = (headers, ancestors) => {
		delete headers['x-frame-options']
		const allow = `frame-ancestors 'self' ${[...ancestors].join(' ')}`.trim()
		const csp = []
			.concat(headers['content-security-policy'] ?? [])
			.map((v) =>
				v
					.split(';')
					.map((d) => d.trim())
					.filter((d) => d && !/^frame-ancestors\b/i.test(d))
					.join('; '),
			)
			.filter(Boolean)
		if (csp.length) csp[0] = `${csp[0]}; ${allow}`
		else csp.push(allow)
		headers['content-security-policy'] = csp
	}
	// The address a browser sees for this request (Cloudflare tunnels arrive as https).
	const publicOrigin = (req) => (/^[a-z0-9.\-:[\]]{1,260}$/i.test(req.headers.host ?? '') ? `${req.protocol}://${req.headers.host}` : null)

	// App subdomains for remote access (Cloudflare tunnel etc.): TOUCH_APP_HOSTS="{app}-touch.example.com"
	// routes e.g. forgejo-touch.example.com to Forgejo through the relay, on Touch's own port.
	const appHostPattern = (() => {
		const p = String(store.getConfig().appHosts ?? '').trim().toLowerCase()
		if (!/^[a-z0-9.\-]*\{app\}[a-z0-9.\-]*$/.test(p) || !p.includes('.')) return null
		const [pre, post] = p.split('{app}')
		const esc = (x) => x.replace(/[.\-]/g, (m) => `\\${m}`)
		return {post, make: (id) => `${pre}${id.toLowerCase()}${post}`, match: new RegExp(`^${esc(pre)}([a-z0-9-]{1,100})${esc(post)}$`)}
	})()
	appHostFrameSrc = () => {
		if (!appHostPattern) return ''
		const post = appHostPattern.post
		const domain = post.slice(post.indexOf('.') + 1)
		return domain.includes('.') ? `https://*.${domain}` : ''
	}
	const appIdForHost = (req) => {
		if (!appHostPattern) return null
		const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
		return appHostPattern.match.exec(host)?.[1] ?? null
	}

	function startRelay(app, umbrelHost) {
		const relay = {appId: app.id, port: 0, targetPort: app.port, ancestors: new Set(), server: null}
		const upstream = (req, sid) => ({host: umbrelHost, port: relay.targetPort, method: req.method, path: req.url, headers: relayHeaders(req, sid)})
		relay.handle = (req, res) => {
			const url = new URL(req.url ?? '/', 'http://x')
			if (url.pathname === '/__touch/ping.gif') {
				res.writeHead(200, {'content-type': 'image/gif', 'cache-control': 'no-store'})
				return res.end(PING_GIF)
			}
			if (url.pathname === '/__touch/enter') {
				// One-time hand-over from Touch to this app's own address (sets a per-app cookie).
				const t = appTickets.get(url.searchParams.get('t') ?? '')
				appTickets.delete(url.searchParams.get('t') ?? '')
				if (!t || t.exp < Date.now() || t.appId !== app.id || !store.getSession(t.sid)) {
					res.writeHead(401, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'})
					return res.end('This link has expired. Open the app again from UmbrelOS Touch.')
				}
				const id = randomBytes(32).toString('base64url')
				appSessions.set(id, {sid: t.sid, appId: app.id, exp: Date.now() + 12 * 60 * 60 * 1000})
				const r = url.searchParams.get('r') ?? '/'
				const secure = req.headers['x-forwarded-proto'] === 'https' && isLoopback(String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''))
				res.writeHead(302, {
					location: r.startsWith('/') && !r.startsWith('//') ? r : '/',
					'set-cookie': `${APP_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`,
					'cache-control': 'no-store',
				})
				return res.end()
			}
			const sid = relaySid(req, app.id)
			if (!sid) {
				res.writeHead(401, {'content-type': 'text/plain; charset=utf-8'})
				return res.end('Sign in to UmbrelOS Touch first.')
			}
			const up = http.request(upstream(req, sid), (ur) => {
				const headers = {...ur.headers}
				const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '')
				if (headers.location) {
					try {
						const to = new URL(headers.location, `http://${req.headers.host}`)
						if (to.pathname.startsWith('/app-auth') && to.port !== String(relay.port)) {
							// umbrelOS wants a fresh sign-in; its page can't load in a window.
							ur.resume()
							res.writeHead(401, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
							return res.end('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#888;text-align:center;padding:24px">Your umbrelOS app session ended.<br>Sign out of UmbrelOS Touch and back in, then reopen this app.</body>')
						}
						if (to.port === String(relay.targetPort) && (to.hostname === hostname || isLoopback(to.hostname) || to.hostname === umbrelHost)) {
							to.host = req.headers.host
							headers.location = to.href
						}
					} catch {
						/* leave it */
					}
				}
				frameHeaders(headers, relay.ancestors)
				res.writeHead(ur.statusCode ?? 502, ur.statusMessage, headers)
				ur.pipe(res)
			})
			up.on('error', () => {
				if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'})
				res.end('The app isn’t answering right now.')
			})
			req.pipe(up)
		}
		relay.upgrade = (req, socket, head) => {
			const sid = relaySid(req, app.id)
			if (!sid) return socket.destroy()
			const up = http.request(upstream(req, sid))
			up.on('upgrade', (ur, us, uhead) => {
				const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}`]
				for (let i = 0; i < ur.rawHeaders.length; i += 2) lines.push(`${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}`)
				socket.write(`${lines.join('\r\n')}\r\n\r\n`)
				if (uhead?.length) socket.write(uhead)
				us.pipe(socket)
				socket.pipe(us)
				us.on('error', () => socket.destroy())
				socket.on('error', () => us.destroy())
			})
			up.on('response', (ur) => {
				socket.end(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\nConnection: close\r\n\r\n`)
				ur.resume()
			})
			up.on('error', () => socket.destroy())
			up.end(head)
		}
		const server = http.createServer(relay.handle)
		server.requestTimeout = 0
		server.on('upgrade', relay.upgrade)
		relay.server = server
		return relay
	}
	// App subdomains share Touch's port: route them before anything else.
	const relaysByApp = new Map() // appId -> relay (subdomain mode; no listener of its own)
	async function hostRelay(appId, sid) {
		const apps = await getClient().query('apps.list', undefined, {token: await accessTokenFor(sid, store.getSession(sid))}).catch(() => null)
		const app = apps?.find((a) => a.id === appId)
		if (!app?.port) return null
		let relay = relaysByApp.get(appId)
		if (!relay || relay.targetPort !== app.port) {
			relay = startRelay(app, new URL(getClient().baseUrl).hostname)
			relaysByApp.set(appId, relay)
		}
		return relay
	}
	hostRoute = async (req, res, next) => {
		const appId = appIdForHost(req)
		if (!appId) return next()
		if (req.path === '/__touch/ping.gif') {
			res.writeHead(200, {'content-type': 'image/gif', 'cache-control': 'no-store'})
			return void res.end(PING_GIF)
		}
		const t = appTickets.get(new URL(req.url, 'http://x').searchParams.get('t') ?? '')
		const sid = relaySid(req, appId) ?? (t?.appId === appId ? t.sid : null)
		const relay = sid ? relaysByApp.get(appId) ?? (await hostRelay(appId, sid)) : null
		if (!relay) {
			res.status(401).type('text/plain').send('Open this app from UmbrelOS Touch.')
			return
		}
		relay.port = -1
		relay.handle(req, res)
	}
	app.relayUpgrade = (req, socket, head) => {
		const appId = appIdForHost(req)
		if (!appId) return false
		const relay = relaysByApp.get(appId)
		if (relay) relay.upgrade(req, socket, head)
		else socket.destroy()
		return true
	}

	async function relayFor(app, umbrelHost, ancestor) {
		let relay = relays.get(app.id)
		if (relay && relay.targetPort !== app.port) {
			relay.server.close()
			relays.delete(app.id)
			relay = null
		}
		if (!relay) {
			relay = startRelay(app, umbrelHost)
			const taken = new Set([...relays.values()].map((r) => r.port))
			const candidates = relayPortBase ? Array.from({length: 100}, (_, i) => relayPortBase + i).filter((p) => !taken.has(p)) : [0]
			let ok = false
			for (const port of candidates) {
				ok = await new Promise((resolve) => {
					relay.server.once('error', () => resolve(false))
					relay.server.listen(port, relayHost, () => resolve(true))
				})
				if (ok) break
			}
			if (!ok) return null
			relay.server.on('error', () => {})
			relay.port = relay.server.address().port
			relays.set(app.id, relay)
		}
		if (ancestor) relay.ancestors.add(ancestor)
		return relay.port
	}
	app.closeRelays = () => {
		for (const r of relays.values()) r.server.close()
		relays.clear()
	}

	// How each app opens on the desktop. With Touch's own umbrelOS app session (every sign-in
	// since 0.12), every app is relayed, so it opens in a window with no extra sign-in. Without it,
	// only apps that forbid embedding are relayed and the browser's own umbrelOS sign-in applies.
	//   results[id]: window | tab | signin | unknown
	//   relay[id]:   true when the app opens through a relay (ask /api/app-open for its address)
	const isIpOrLocal = (h) => /^[\d.]+$/.test(h) || h.includes(':') || h.endsWith('.local') || h === 'localhost' || !h.includes('.')
	const relayMode = (req) => {
		const host = req.hostname ?? ''
		if (appHostPattern && !isIpOrLocal(host)) return 'host'
		// An HTTPS page can't show a plain-HTTP relay port; remote (tunnel) access needs app hosts.
		return req.secure ? null : 'port'
	}
	api.get('/app-frame', async (req, res) => {
		res.set('Cache-Control', 'no-store')
		try {
			const ids = String(req.query.apps ?? '')
				.split(',')
				.filter((id) => /^[a-zA-Z0-9-]{1,100}$/.test(id))
				.slice(0, 60)
			const apps = await authedCall(req, 'apps.list', 'query')
			const sso = !!store.getSession(req.sid)?.console?.appCookie
			const mode = relayMode(req)
			const cookies = parseCookies(req.headers.cookie)
			const held = store.getSession(req.sid)?.console?.appCookie
			// Only umbrelOS's own app-session cookies are sent (current and older umbrelOS).
			const cookieHeader =
				held ??
				['UMBREL_APP_SESSION', 'UMBREL_PROXY_TOKEN']
					.filter((n) => typeof cookies[n] === 'string' && cookies[n].length < 4096)
					.map((n) => `${n}=${encodeURIComponent(cookies[n])}`)
					.join('; ')
			const umbrelHost = new URL(getClient().baseUrl).hostname
			const results = {}
			const relay = {}
			await Promise.all(
				ids.map(async (id) => {
					const app = apps.find((a) => a.id === id)
					if (!app?.port) return void (results[id] = 'unknown')
					if (app.requiresHttps) return void (results[id] = 'tab')
					if (sso && mode) {
						relay[id] = true
						return void (results[id] = 'window')
					}
					const key = `${id}:${app.port}:${cookieHeader ? 1 : 0}`
					const hit = appFrameCache.get(key)
					let verdict = hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.verdict : await frameVerdict(app, umbrelHost, cookieHeader)
					if (verdict === 'window' || verdict === 'tab' || verdict === 'blocked') appFrameCache.set(key, {verdict, at: hit?.at ?? Date.now()})
					if (verdict === 'blocked') {
						if (mode) relay[id] = true
						verdict = mode ? 'window' : 'tab'
					}
					results[id] = verdict
				}),
			)
			res.json({results, relay, sso, remote: !mode})
		} catch (error) {
			sendError(res, error)
		}
	})
	// The address to load an app window from: a relay port, or a one-time hand-over to the
	// app's own subdomain (which then sets a per-app cookie there).
	api.get('/app-open', async (req, res) => {
		res.set('Cache-Control', 'no-store')
		try {
			const id = String(req.query.app ?? '')
			if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad app'}})
			const apps = await authedCall(req, 'apps.list', 'query')
			const app = apps.find((a) => a.id === id)
			if (!app?.port) return res.status(404).json({error: {code: 'NOT_FOUND', message: 'That app has no web interface'}})
			const mode = relayMode(req)
			const path = typeof app.path === 'string' && app.path.startsWith('/') ? app.path : '/'
			const ancestor = publicOrigin(req)
			const umbrelHost = new URL(getClient().baseUrl).hostname
			if (mode === 'host') {
				const host = appHostPattern.make(app.id)
				let relay = relaysByApp.get(app.id)
				if (!relay || relay.targetPort !== app.port) {
					relay = startRelay(app, umbrelHost)
					relaysByApp.set(app.id, relay)
				}
				if (ancestor) relay.ancestors.add(ancestor)
				const t = randomBytes(32).toString('base64url')
				appTickets.set(t, {sid: req.sid, appId: app.id, exp: Date.now() + 2 * 60 * 1000})
				for (const [k, v] of appTickets) if (v.exp < Date.now()) appTickets.delete(k)
				return res.json({url: `${req.protocol}://${host}/__touch/enter?t=${t}&r=${encodeURIComponent(path)}`, ping: `${req.protocol}://${host}/__touch/ping.gif`})
			}
			if (mode === 'port') {
				const port = await relayFor(app, umbrelHost, ancestor)
				if (!port) return res.status(503).json({error: {code: 'UNAVAILABLE', message: 'No free port for the app relay'}})
				const h = req.hostname.includes(':') ? `[${req.hostname}]` : req.hostname
				return res.json({url: `http://${h}:${port}${path}`, ping: `http://${h}:${port}/__touch/ping.gif`})
			}
			res.status(409).json({error: {code: 'NEEDS_APP_HOSTS', message: 'Opening apps remotely needs app addresses (TOUCH_APP_HOSTS)'}})
		} catch (error) {
			sendError(res, error)
		}
	})

	// Asked before the socket opens so the app can show a clear reason when it can't.
	api.get('/console/check', async (req, res) => {
		try {
			await consoleTicket(req.sid, req.query.target === 'terminal' ? 'terminal' : 'machines') // single-use, 30s; discarded
			res.json({ok: true})
		} catch (error) {
			sendError(res, error)
		}
	})

	// WebSocket bridges: phone <-> this server <-> umbreld.
	//   /api/console?machineId=…            -> /machines/console (raw VNC, binary)
	//   /api/terminal?appId=…&cols=…&rows=… -> /terminal (shell text; appId = a shell inside that app)
	app.attachConsole = (server) => {
		const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024})
		server.on('upgrade', async (req, socket, head) => {
			if (app.relayUpgrade(req, socket, head)) return
			const refuse = (status) => {
				socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
				socket.destroy()
			}
			try {
				const url = new URL(req.url, 'http://x')
				const route = {'/api/console': 'machines', '/api/terminal': 'terminal'}[url.pathname]
				if (!route) return refuse('404 Not Found')
				// Browsers always send Origin on WebSocket handshakes: refuse other sites.
				const origin = req.headers.origin
				if (!origin || new URL(origin).host !== req.headers.host) return refuse('403 Forbidden')
				const sid = parseCookies(req.headers.cookie)[COOKIE]
				if (!store.getSession(sid)) return refuse('401 Unauthorized')
				const target = new URL(getClient().baseUrl)
				target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
				let params
				if (route === 'machines') {
					const machineId = url.searchParams.get('machineId') ?? ''
					if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) return refuse('400 Bad Request')
					target.pathname = '/machines/console'
					params = {machineId, sessionId: randomUUID()}
				} else {
					const appId = url.searchParams.get('appId') ?? ''
					const cols = Number(url.searchParams.get('cols'))
					const rows = Number(url.searchParams.get('rows'))
					if (appId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(appId)) return refuse('400 Bad Request')
					if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 4 || rows > 300) return refuse('400 Bad Request')
					target.pathname = '/terminal'
					params = {...(appId ? {appId} : {}), cols: String(cols), rows: String(rows)}
				}
				const ticket = await consoleTicket(sid, route)
				target.search = new URLSearchParams({...params, ticket}).toString()
				const upstream = new WebSocket(target, route === 'machines' ? ['binary'] : [], {handshakeTimeout: 10_000})
				upstream.once('error', () => refuse('502 Bad Gateway'))
				upstream.once('open', () => {
					upstream.removeAllListeners('error')
					wss.handleUpgrade(req, socket, head, (client) => {
						const closeBoth = (code, reason) => {
							const safe = typeof code === 'number' && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000
							for (const ws of [client, upstream]) if (ws.readyState === WebSocket.OPEN) ws.close(safe, reason)
						}
						upstream.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, {binary: isBinary}))
						client.on('message', (data, isBinary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, {binary: isBinary}))
						upstream.on('close', (code, reason) => closeBoth(code, reason))
						client.on('close', () => closeBoth(1000))
						upstream.on('error', () => client.terminate())
						client.on('error', () => upstream.terminate())
					})
				})
			} catch {
				refuse('502 Bad Gateway')
			}
		})
		return wss
	}

	// ---- Allowlisted proxy ---------------------------------------------------
	const proxy = async (req, res) => {
		const path = req.params.path
		const kind = ALLOWED[path]
		if (!kind) return res.status(404).json({error: {code: 'NOT_FOUND', message: `${path} is not available in UmbrelOS Touch`}})
		if ((kind === 'query') !== (req.method === 'GET')) {
			return res.status(405).json({error: {code: 'METHOD_NOT_SUPPORTED', message: 'Wrong method'}})
		}
		let input
		try {
			input = kind === 'query' ? (req.query.input === undefined ? undefined : JSON.parse(String(req.query.input))) : req.body?.input
		} catch {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Malformed input'}})
		}
		try {
			const data = await authedCall(req, path, kind, input)
			res.json({data: data ?? null})
		} catch (error) {
			if (error instanceof UmbrelError && error.code === 'UNAUTHORIZED' && !store.getSession(req.sid)) setCookie(res, '', 0)
			sendError(res, error)
		}
	}
	api.get('/rpc/:path', proxy)
	api.post('/rpc/:path', proxy)

	api.get('/health', (req, res) => res.json({ok: true, version: VERSION}))
	api.use((req, res) => res.status(404).json({error: {code: 'NOT_FOUND', message: 'Not found'}}))
	app.use('/api', api)

	// ---- PWA -----------------------------------------------------------------
	if (staticDir && existsSync(staticDir)) {
		app.use('/assets', express.static(join(staticDir, 'assets'), {immutable: true, maxAge: '1y'}))
		app.use(express.static(staticDir, {index: false, maxAge: 0}))
		app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(join(staticDir, 'index.html')))
	}
	return app
}
