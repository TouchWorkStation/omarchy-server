// omarchyd: the Omarchy Server backend. It listens on localhost only; the Touch web server in front
// of it is the one thing that faces the network. Runs as the owner's own user, not root.
import {readFile, realpath} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {extname, join} from 'node:path'

import {openAccounts} from './accounts.mjs'
import {createFiles} from './files.mjs'
import {RpcError, handleRpc, sendError, sendJson} from './rpc.mjs'
import * as system from './system.mjs'

export const OMARCHYD_VERSION = '0.1.0'

export async function startOmarchyd({port = 2021, host = '127.0.0.1', dataDir, home = os.homedir()}) {
	const accounts = await openAccounts(dataDir)
	const files = createFiles({home, dataDir})
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
				const {bearer, cookie} = await accounts.loginBrowser(input)
				res.setHeader('set-cookie', [`OMARCHY_BROWSER_SESSION=${cookie}; Path=/; HttpOnly; SameSite=Strict`])
				return bearer
			},
		},
		'user.renewToken': {kind: 'mutation', run: async (_i, {auth}) => (auth.kind === 'browser' && (await accounts.renewBrowser(auth.bearer)), 'renewed')},
		'user.logout': {kind: 'mutation', run: async (_i, {auth}) => (await accounts.logout(auth), true)},
		'user.get': {kind: 'query', run: (_i, {auth}) => ({...accounts.getUser(auth.userId), wallpaper: {id: '1'}})},
		'user.set': {kind: 'mutation', run: async (input, {auth}) => (await accounts.updateUser(auth.userId, input), true)},
		'user.changePassword': {kind: 'mutation', run: async (input, {auth}) => (await accounts.setPassword(auth.userId, input ?? {}), true)},
		'user.getHttpApiToken': {kind: 'query', run: (_i, {auth}) => accounts.issueUrlToken(auth)},
		'user.createWebSocketTicket': {kind: 'mutation', run: () => {
			throw new RpcError('NOT_FOUND', 'Consoles arrive in a later Omarchy Server release')
		}},

		// ---- system ---------------------------------------------------------------------------
		'system.uptime': {kind: 'query', run: () => Math.round(os.uptime())},
		'system.cpuUsage': {kind: 'query', run: () => system.cpuUsage()},
		'system.memoryUsage': {kind: 'query', run: () => system.memoryUsage()},
		'system.diskUsage': {kind: 'query', run: () => system.diskUsage(home)},
		'system.cpuTemperature': {kind: 'query', run: () => system.cpuTemperature()},
		'system.getHostname': {kind: 'query', run: () => settings.hostname},
		'system.getIpAddresses': {kind: 'query', run: () => system.ipAddresses()},
		'system.device': {kind: 'query', run: async () => ({device: await system.deviceName(), os: release.pretty})},
		'system.checkUpdate': {kind: 'query', run: () => ({available: false, version: OMARCHYD_VERSION, name: `Omarchy Server ${OMARCHYD_VERSION}`})},
		'system.updateStatus': {kind: 'query', run: () => ({running: false, progress: 0, description: '', error: false})},

		// ---- not built yet: answer empty so the web app shows empty states, not errors ----------
		'apps.list': {kind: 'query', run: () => []},
		'apps.recentlyOpened': {kind: 'query', run: () => []},
		'appStore.registry': {kind: 'query', run: () => []},
		'appStore.repositories': {kind: 'query', run: () => []},
		'machines.list': {kind: 'query', run: () => []},
		'notifications.get': {kind: 'query', run: () => []},
		'wifi.connected': {kind: 'query', run: () => ({status: 'disconnected'})},
		'wifi.networks': {kind: 'query', run: () => []},

		...files.procedures,
	}

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
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, resolve)
	})
	return {url: `http://${host}:${server.address().port}`, accounts, close: () => new Promise((r) => server.close(r))}
}
