// TEST-ONLY stand-in for umbreld. It reproduces the tRPC v11 wire format and the
// auth rules of umbrelOS 2.0 (native access tokens that expire, device-token
// refresh, owner-only procedures) so the server can be tested without a real
// Umbrel. It is never shipped or used by the app itself.

import http from 'node:http'
import {readFile, readdir} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {WebSocketServer} from 'ws'

export async function startFakeUmbreld({
	port = 0,
	accessTtlMs = 60 * 60 * 1000,
	legacy = false,
	password = 'correct horse',
	wallpaperDir = process.env.FAKE_WALLPAPER_DIR,
} = {}) {
	const wallpaper = {id: process.env.FAKE_WALLPAPER_ID ?? '23', brandColorHsl: process.env.FAKE_BRAND ?? '24 90% 50%'}
	let baseUrl = ''
	const tokens = new Map() // access token -> {expiresAt, sessionId}
	const devices = new Map() // device token -> sessionId
	const calls = []
	const browser = new Map() // dashboard token -> browser-session cookie value
	const urlTokens = new Map() // file URL token -> browser-session cookie value
	const tickets = new Set()
	// In-memory file tree for the Files tab: path -> {type, size, modified, data?}
	const now = Date.now()
	const fsTree = new Map([
		['/Home', {type: 'directory'}],
		['/Home/Documents', {type: 'directory'}],
		['/Home/Photos', {type: 'directory'}],
		['/Home/Movies', {type: 'directory'}],
		['/Home/Downloads', {type: 'directory'}],
		['/Home/Documents/Budget 2026.xlsx', {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 48210}],
		['/Home/Documents/Notes.txt', {type: 'text/plain', data: Buffer.from('Hello from your Umbrel.\nThis is a text file.\n')}],
		['/Home/Documents/Service manual.pdf', {type: 'application/pdf', size: 3_400_000}],
		['/Home/Photos/Sunset.jpg', {type: 'image/jpeg', wallpaper: 9}],
		['/Home/Photos/Mountains.jpg', {type: 'image/jpeg', wallpaper: 12}],
		['/Home/Photos/Lake.jpg', {type: 'image/jpeg', wallpaper: 17}],
		['/Home/Photos/Coast.jpg', {type: 'image/jpeg', wallpaper: 20}],
		['/Home/Movies/Trip.mp4', {type: 'video/mp4', size: 812_000_000}],
		['/Home/Downloads/umbrelos.iso', {type: 'application/x-iso9660-image', size: 1_900_000_000}],
		['/Home/backup.zip', {type: 'application/zip', size: 22_000_000}],
		['/Apps', {type: 'directory'}],
		['/Apps/immich', {type: 'directory'}],
		['/External', {type: 'directory'}],
		['/Network', {type: 'directory'}],
		['/Trash', {type: 'directory'}],
		['/Trash/old-notes.txt', {type: 'text/plain', data: Buffer.from('old')}],
	])
	let updateStatus = {running: false, progress: 0, description: '', error: false}
	const OFFICIAL_STORE = 'https://github.com/getumbrel/umbrel-apps.git'
	const communityStores = []
	// Optional real sample files (FAKE_SAMPLES_DIR) for exercising the file viewer.
	const MIME = {pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', csv: 'text/csv', md: 'text/markdown', json: 'application/json', txt: 'text/plain', py: 'text/x-python', zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', ttf: 'font/ttf', key: 'application/vnd.apple.keynote', heic: 'image/heic', iso: 'application/x-iso9660-image', gz: 'application/gzip'}
	const typeFor = (name) => MIME[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream'
	if (process.env.FAKE_SAMPLES_DIR) {
		fsTree.set('/Home/Samples', {type: 'directory'})
		for (const name of await readdir(process.env.FAKE_SAMPLES_DIR)) fsTree.set(`/Home/Samples/${name}`, {type: typeFor(name), data: await readFile(`${process.env.FAKE_SAMPLES_DIR}/${name}`)})
	}
	for (const [, v] of fsTree) v.modified ??= now - Math.floor(Math.random() * 30 * 864e5)
	const sizeOf = (v) => v.data?.length ?? v.size ?? (v.wallpaper ? 250_000 : 0)
	const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/'
	const baseName = (p) => p.slice(p.lastIndexOf('/') + 1)
	const entry = (path) => {
		const v = fsTree.get(path)
		const dir = v.type === 'directory'
		const inTrash = path.startsWith('/Trash/')
		return {
			name: baseName(path),
			path,
			type: v.type,
			...(dir ? {} : {size: sizeOf(v)}),
			modified: v.modified,
			operations: inTrash ? ['restore', 'delete'] : ['copy', 'move', 'rename', 'trash', 'favorite', 'writable', ...(dir ? ['share'] : [])],
			...(/zip|gzip|x-tar|7z|rar/.test(v.type) && !inTrash ? {operations: ['copy', 'move', 'rename', 'trash', 'favorite', 'unarchive']} : {}),
			...(v.type.startsWith('image/') ? {thumbnail: `${baseName(path).replace(/\W/g, '')}.webp`} : {}),
		}
	}
	const children = (dir) => [...fsTree.keys()].filter((k) => k !== dir && parentOf(k) === dir)
	const needDir = (p) => {
		if (fsTree.get(p)?.type !== 'directory') throw ['NOT_FOUND', '[does-not-exist]']
	}
	const uniqueIn = (dir, name) => {
		let candidate = `${dir}/${name}`
		const dot = name.lastIndexOf('.')
		for (let n = 2; fsTree.has(candidate); n++) candidate = `${dir}/${dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`}`
		return candidate
	}
	const moveTree = (from, to, copy) => {
		for (const k of [...fsTree.keys()]) {
			if (k === from || k.startsWith(`${from}/`)) {
				fsTree.set(to + k.slice(from.length), {...fsTree.get(k), modified: Date.now()})
				if (!copy) fsTree.delete(k)
			}
		}
	}
	const favorites = new Set(['/Home/Documents'])
	const smbShares = [{name: 'Home', path: '/Home', available: true, sharename: 'Home'}]
	const fsOp = (fn) => (input, auth) => {
		try {
			return fn(input, auth)
		} catch (e) {
			if (Array.isArray(e)) return {error: e}
			throw e
		}
	}
	const settings = {twoFactor: false, channel: 'stable', hostname: 'umbrel', externalDns: true, tor: false}
	let lastCreate = null
	const keys = [] // keysyms typed into the fake VM console
	const terminals = []
	const gb = 1024 ** 3
	const apps = [
		{id: 'nextcloud', name: 'Nextcloud', version: '30.0.2', port: 8081, path: '', state: 'ready'},
		{id: 'immich', name: 'Immich', version: '1.120.0', port: 2283, path: '', state: 'ready'},
		{id: 'jellyfin', name: 'Jellyfin', version: '10.10.3', port: 8096, path: '', state: 'stopped'},
		{id: 'home-assistant', name: 'Home Assistant', version: '2024.12.1', port: 8123, path: '', state: 'ready'},
	].map((a) => ({
		...a,
		icon: `https://getumbrel.github.io/umbrel-apps-gallery/${a.id}/icon.svg`,
		progress: 0,
		autoStart: true,
		credentials: {defaultUsername: '', defaultPassword: '', hideBeforeOpen: false, showBeforeOpen: false},
		hiddenService: '',
		widgets: [],
		dependencies: [],
		selectedDependencies: {},
		implements: [],
		torOnly: false,
		requiresHttps: false,
	}))
	const machines = [
		{id: 'ubuntu-1', name: 'Ubuntu Desktop', osId: 'ubuntu', cores: 4, memoryGb: 8, diskSizeGb: 64, state: process.env.FAKE_VM_RUNNING ? 'running' : 'stopped', ipAddress: '10.21.0.2'},
	]
	let notifications = ['update-available']

	// Each app gets a tiny web server standing in for umbrelOS's app gateway + the app:
	// no app session -> redirect to the sign-in on port 2000 (like umbreld's gateway);
	// signed in -> the app, which may forbid embedding the way real apps do.
	const APP_HEADERS = {
		nextcloud: {'x-frame-options': 'SAMEORIGIN'}, // like Nextcloud / Forgejo
		'home-assistant': {'content-security-policy': "frame-ancestors 'self'"},
		immich: {},
	}
	const appServers = []
	const appSessionTokens = new Set(['good-app-session'])
	const appRequests = [] // cookie headers the "apps" received
	await Promise.all(
		apps.map(
			(a) =>
				new Promise((resolve) => {
					const srv = http.createServer((req, res) => {
						appRequests.push(req.headers.cookie ?? '')
						const token = /(?:^|;\s*)UMBREL_APP_SESSION=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
						if (!appSessionTokens.has(token)) {
							res.writeHead(302, {location: `http://${req.headers.host?.split(':')[0]}:2000/app-auth?origin=host&app=${a.id}&path=${encodeURIComponent(req.url)}`})
							return res.end()
						}
						if (a.id === 'immich' && req.url === '/') {
							res.writeHead(302, {location: '/photos'})
							return res.end()
						}
						res.writeHead(200, {'content-type': 'text/html', ...APP_HEADERS[a.id]})
						res.end(`<!doctype html><title>${a.name}</title><h1>${a.name}</h1>`)
					})
					srv.listen(0, '127.0.0.1', () => {
						a.port = srv.address().port
						appServers.push(srv)
						resolve()
					})
				}),
		),
	)

	const newToken = () => randomBytes(24).toString('base64url')
	const issueAccess = (sessionId) => {
		const accessToken = newToken()
		const accessExpiresAt = Date.now() + accessTtlMs
		tokens.set(accessToken, {expiresAt: accessExpiresAt, sessionId})
		return {accessToken, accessExpiresAt}
	}

	const procedures = {
		'system.version': {kind: 'query', public: true, run: () => ({version: '2.0.0', name: 'umbrelOS 2.0'})},
		'system.discoveryInfo': {kind: 'query', public: true, run: () => ({id: 'abc', device: 'Linux VM', version: '2.0.0', onboarded: true})},
		'user.listAccounts': {kind: 'query', public: true, run: () => [{userId: 'owner', name: 'Chris', language: 'en', wallpaper}]},
		'user.loginNative': {
			kind: 'mutation',
			public: true,
			run: (input) => {
				if (legacy) return {notFound: true}
				if (input?.password !== password) return {error: ['UNAUTHORIZED', 'Incorrect password']}
				if (!input?.client?.id) return {error: ['BAD_REQUEST', 'Missing client']}
				const sessionId = newToken()
				const deviceToken = newToken()
				devices.set(deviceToken, sessionId)
				return {accountId: 'owner', ...issueAccess(sessionId), deviceToken}
			},
		},
		'user.refreshNativeAccess': {
			kind: 'mutation',
			public: true,
			run: (input) => {
				const sessionId = devices.get(input?.deviceToken)
				if (!sessionId) return {error: ['UNAUTHORIZED', 'Invalid native session']}
				return issueAccess(sessionId)
			},
		},
		'user.login': {
			kind: 'mutation',
			public: true,
			run: (input, _auth, res) => {
				if (input?.password !== password) return {error: ['UNAUTHORIZED', 'Incorrect password']}
				const {accessToken} = issueAccess(legacy ? 'legacy' : newToken())
				tokens.get(accessToken).expiresAt = Infinity
				const cookie = newToken()
				browser.set(accessToken, cookie)
				const appTok = newToken()
				appSessionTokens.add(appTok)
				res.setHeader('set-cookie', [`UMBREL_APP_SESSION=${appTok}; Path=/; HttpOnly`, `UMBREL_BROWSER_SESSION=${cookie}; Path=/; HttpOnly; SameSite=Lax`])
				return accessToken
			},
		},
		// Like umbreld: tickets are only issued to browser sessions (dashboard token + cookie), never native ones.
		'user.createWebSocketTicket': {
			kind: 'mutation',
			run: (input, auth, _res, req) => {
				const token = req.headers.authorization?.split(' ')[1]
				const cookie = browser.get(token)
				if (!cookie || legacy) return {error: ['FORBIDDEN', 'Browser session required']}
				if (!String(req.headers.cookie ?? '').includes(`UMBREL_BROWSER_SESSION=${cookie}`)) return {error: ['UNAUTHORIZED', 'Invalid token']}
				const ticket = `${input.target}:${newToken()}`
				tickets.add(ticket)
				return ticket
			},
		},
		'user.renewToken': {kind: 'mutation', run: () => 'renewed'},
		'user.logout': {
			kind: 'mutation',
			run: (_, auth) => {
				for (const [t, v] of tokens) if (v.sessionId === auth.sessionId) tokens.delete(t)
				for (const [d, s] of devices) if (s === auth.sessionId) devices.delete(d)
				return true
			},
		},
		'user.get': {kind: 'query', run: () => ({userId: 'owner', name: 'Chris', role: 'owner', wallpaper, sambaUsername: 'umbrel'})},
		'apps.recentlyOpened': {kind: 'query', run: () => ['immich', 'home-assistant']},
		'system.uptime': {kind: 'query', run: () => 1_234_567},
		'system.cpuTemperature': {kind: 'query', run: () => ({warning: 'normal', temperature: 52})},
		'system.cpuUsage': {
			kind: 'query',
			run: () => ({threads: 16, totalUsed: 18.4, system: 9.1, apps: [{id: 'immich', used: 6.2}, {id: 'nextcloud', used: 3.1}], machines: []}),
		},
		'system.memoryUsage': {
			kind: 'query',
			run: () => ({size: 16 * gb, totalUsed: 6.2 * gb, system: 2 * gb, apps: [{id: 'immich', used: 2.1 * gb}], machines: []}),
		},
		'system.diskUsage': {
			kind: 'query',
			run: () => ({size: 1000 * gb, totalUsed: 720 * gb, available: 280 * gb, system: 40 * gb, files: 300 * gb, apps: [{id: 'immich', used: 210 * gb}], machines: []}),
		},
		'apps.list': {kind: 'query', run: () => apps},
		'apps.state': {kind: 'query', run: ({appId}) => apps.find((a) => a.id === appId) ?? {state: 'not-installed', progress: 0}},
		'apps.updates': {kind: 'query', run: () => [{id: 'nextcloud', version: '30.0.4'}]},
		'apps.logs': {kind: 'query', run: ({appId}) => `${appId}_server_1  | ready\n`},
		'apps.start': {kind: 'mutation', run: ({appId}) => ((apps.find((a) => a.id === appId).state = 'ready'), true)},
		'apps.stop': {kind: 'mutation', run: ({appId}) => ((apps.find((a) => a.id === appId).state = 'stopped'), true)},
		'apps.restart': {kind: 'mutation', run: () => true},
		'appStore.registry': {
			kind: 'query',
			run: () => {
				const shot = (n) => `${baseUrl}/assets/wallpapers/${n}.jpg`
				const app = (id, name, category, tagline, gallery = [], extra = {}) => ({
					id, name, category, tagline, version: '1.0.0', icon: '', developer: `${name} team`, gallery, dependencies: [],
					description: `${name} on your Umbrel. ${tagline}.`, installSize: 250e6, compatible: true, ...extra,
				})
				return [{url: OFFICIAL_STORE, meta: {id: 'umbrel-app-store', name: 'Umbrel App Store'}, apps: [
					app('immich', 'Immich', 'files', 'Your photos and videos, on your terms', [shot(5), shot(9)]),
					app('nextcloud', 'Nextcloud', 'files', 'Productivity platform that keeps you in control', [shot(12)]),
					app('vaultwarden', 'Vaultwarden', 'files', 'Unofficial Bitwarden-compatible password manager'),
					app('home-assistant', 'Home Assistant', 'automation', 'Home automation that puts local control first', [shot(17)]),
					app('jellyfin', 'Jellyfin', 'media', 'The free software media system', [shot(20)]),
					app('plex', 'Plex', 'media', 'Stream movies and TV shows'),
					app('navidrome', 'Navidrome', 'media', 'Your music collection, everywhere'),
					app('ollama', 'Ollama', 'ai', 'Run large language models locally', [shot(1)]),
					app('open-webui', 'Open WebUI', 'ai', 'Chat with local models in your browser', [], {dependencies: ['ollama']}),
					app('bitcoin', 'Bitcoin Node', 'bitcoin', 'Run your own Bitcoin node', [shot(3)]),
					app('pi-hole', 'Pi-hole', 'networking', 'Block ads across your whole network'),
					app('tailscale', 'Tailscale', 'networking', 'Zero-config VPN for your devices'),
				]}, ...communityStores.map((r) => ({...r, apps: r.apps.map((a) => app(...a))}))]
			},
		},
		'appStore.repositories': {kind: 'query', run: () => [{url: OFFICIAL_STORE, meta: {id: 'umbrel-app-store', name: 'Umbrel App Store'}}, ...communityStores.map(({url, meta}) => ({url, meta}))]},
		'appStore.addRepository': {
			kind: 'mutation',
			run: fsOp(({url}) => {
				if (url === OFFICIAL_STORE || communityStores.some((r) => r.url === url)) throw ['BAD_REQUEST', `Repository ${url} already exists`]
				if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(url)) throw ['INTERNAL_SERVER_ERROR', `Failed to clone ${url}`]
				const tws = /touchworkstation\/app-store/i.test(url)
				communityStores.push({
					url,
					meta: tws ? {id: 'touchworkstation', name: 'TouchWorkStation'} : {id: 'community', name: 'Community'},
					apps: tws
						? [
								['touchworkstation-chrome', 'Google Chrome', 'networking', 'Google Chrome, running on your Umbrel and streamed to any device'],
								['touchworkstation-brave', 'Brave', 'networking', 'Brave, running on your Umbrel and streamed to any device'],
								['touchworkstation-brave-secure', 'Brave (HTTPS)', 'networking', 'Brave on your Umbrel, for use through HTTPS and Cloudflare tunnels'],
							]
						: [],
				})
				return true
			}),
		},
		'appStore.removeRepository': {
			kind: 'mutation',
			run: fsOp(({url}) => {
				if (url === OFFICIAL_STORE) throw ['BAD_REQUEST', 'Cannot remove default repository']
				const i = communityStores.findIndex((r) => r.url === url)
				if (i < 0) throw ['BAD_REQUEST', `Repository ${url} does not exist`]
				communityStores.splice(i, 1)
				return true
			}),
		},
		'apps.installReview': {kind: 'query', run: () => ({requiredFolders: [], gpuAccess: false})},
		'apps.install': {
			kind: 'mutation',
			run: ({appId}) => {
				if (!apps.some((a) => a.id === appId)) apps.push({...apps[0], id: appId, name: appId.replace(/(^|-)\w/g, (c) => c.replace('-', ' ').toUpperCase()), state: 'ready', port: 8200})
				return true
			},
		},
		'machines.list': {kind: 'query', run: () => machines},
		'system.checkUpdate': {kind: 'query', run: () => (process.env.FAKE_UPDATE_FAIL ? {available: true, version: '2.1.0', name: 'umbrelOS 2.1'} : {available: false, version: '2.0.0', name: 'umbrelOS 2.0'})},
		'apps.uninstall': {kind: 'mutation', run: ({appId}) => (apps.splice(apps.findIndex((a) => a.id === appId), 1), true)},
		'machines.start': {kind: 'mutation', run: ({id}) => ((machines.find((m) => m.id === id).state = 'running'), true)},
		'notifications.get': {kind: 'query', run: () => notifications},
		'notifications.clear': {kind: 'mutation', run: (id) => ((notifications = notifications.filter((n) => n !== id)), true)},
		'system.factoryReset': {kind: 'mutation', run: (input) => (input?.password === password ? true : {error: ['UNAUTHORIZED', 'Invalid password']})},
		'machines.capabilities': {kind: 'query', run: () => ({hostArchitecture: 'amd64', libvirtAvailable: true, kvmAvailable: true})},
		'machines.osImages': {
			kind: 'query',
			run: () => [
				{id: 'ubuntu-desktop-amd64', familyId: 'ubuntu', name: 'Ubuntu', variantName: 'Desktop', version: '26.04 LTS', sizeMb: 6100, arch: 'amd64', platform: 'linux', requiresCredentials: true, state: 'available'},
				{id: 'debian-server-amd64', familyId: 'debian', name: 'Debian', variantName: 'Server', version: '13', sizeMb: 420, arch: 'amd64', platform: 'linux', requiresCredentials: true, state: 'downloaded'},
				{id: 'alpine-amd64', familyId: 'alpine', name: 'Alpine Linux', version: '3.24', sizeMb: 70, arch: 'amd64', platform: 'linux', requiresCredentials: true, state: 'available'},
				{id: 'windows-11-amd64', familyId: 'windows-11', name: 'Windows 11', version: '25H2', sizeMb: 7400, arch: 'amd64', platform: 'windows', requiresCredentials: true, evaluation: true, state: 'available'},
				{id: 'ubuntu-desktop-arm64', familyId: 'ubuntu', name: 'Ubuntu', variantName: 'Desktop', version: '26.04 LTS', sizeMb: 5900, arch: 'arm64', platform: 'linux', requiresCredentials: true, state: 'available'},
			],
		},
		'machines.create': {
			kind: 'mutation',
			run: (input) => {
				if (!input?.name || !input.osId || !input.cores || !input.memoryGb || !input.diskSizeGb) return {error: ['BAD_REQUEST', 'Invalid input']}
				const m = {id: `vm-${machines.length + 1}`, name: input.name, osId: input.osId.split('-')[0], cores: input.cores, memoryGb: input.memoryGb, diskSizeGb: input.diskSizeGb, state: 'installing', installProgress: 12, ipAddress: '10.21.0.9'}
				machines.push(m)
				lastCreate = input
				return m
			},
		},
		'machines.uninstall': {kind: 'mutation', run: ({id}) => (machines.splice(machines.findIndex((m) => m.id === id), 1), true)},
		'user.set': {kind: 'mutation', run: (input) => (Object.assign(settings, input), input.wallpaper && (wallpaper.id = input.wallpaper), true)},
		'user.changePassword': {kind: 'mutation', run: (input) => (input.oldPassword === password ? ((password = input.newPassword), true) : {error: ['UNAUTHORIZED', 'Incorrect password']})},
		'user.is2faEnabled': {kind: 'query', public: true, run: () => settings.twoFactor},
		'user.generateTotpUri': {kind: 'query', run: () => 'otpauth://totp/Umbrel:umbrel.local?secret=JBSWY3DPEHPK3PXP&issuer=Umbrel'},
		'user.enable2fa': {kind: 'mutation', run: (input) => (input.totpToken === '123456' ? ((settings.twoFactor = true), true) : {error: ['UNAUTHORIZED', 'Incorrect 2FA code']})},
		'user.disable2fa': {kind: 'mutation', run: (input) => (input.totpToken === '123456' ? ((settings.twoFactor = false), true) : {error: ['UNAUTHORIZED', 'Incorrect 2FA code']})},
		'user.listSessions': {
			kind: 'query',
			run: () => [
				{id: 'a'.repeat(32), createdAt: Date.now() - 6e6, lastSeenAt: Date.now(), client: {type: 'native', id: 'umbrel-touch', platform: 'ios', deviceClass: 'phone', appVersion: '0.4.0', appBuild: '1', osVersion: 'web'}, current: true},
				{id: 'b'.repeat(32), createdAt: Date.now() - 9e7, lastSeenAt: Date.now() - 4e6, client: {type: 'browser', userAgent: 'Chrome on Windows'}, current: false},
			],
		},
		'user.revokeSession': {kind: 'mutation', run: () => ({revokedCurrent: false})},
		'user.revokeOtherSessions': {kind: 'mutation', run: () => ({revokedCount: 1})},
		'system.updateStatus': {kind: 'query', run: () => updateStatus},
		'system.update': {
			kind: 'mutation',
			run: () => {
				// FAKE_UPDATE_FAIL: fail the way umbreld reports it, through the status.
				updateStatus = process.env.FAKE_UPDATE_FAIL
					? {running: false, progress: 0, description: '', error: "umbrelOS 2.1.0 doesn't include an update for this device"}
					: {running: true, progress: 40, description: 'Downloading update', error: false}
				return !process.env.FAKE_UPDATE_FAIL
			},
		},
		'system.getReleaseChannel': {kind: 'query', run: () => settings.channel},
		'system.setReleaseChannel': {kind: 'mutation', run: ({channel}) => ((settings.channel = channel), true)},
		'system.getHostname': {kind: 'query', run: () => settings.hostname},
		'system.setHostname': {kind: 'mutation', run: ({hostname}) => ((settings.hostname = hostname), true)},
		'system.getIpAddresses': {kind: 'query', run: () => ['192.168.1.50']},
		'system.isExternalDns': {kind: 'query', run: () => settings.externalDns},
		'system.setExternalDns': {kind: 'mutation', run: (v) => ((settings.externalDns = v), true)},
		'apps.getTorEnabled': {kind: 'query', run: () => settings.tor},
		'apps.setTorEnabled': {kind: 'mutation', run: (v) => ((settings.tor = v), true)},
		'wifi.supported': {kind: 'query', run: () => false},
		'wifi.connected': {kind: 'query', run: () => ({status: 'disconnected'})},
		'wifi.networks': {kind: 'query', run: () => []},
		'user.getHttpApiToken': {
			kind: 'query',
			run: (_i, _a, _res, req) => {
				const token = req.headers.authorization?.split(' ')[1]
				if (!browser.get(token)) return {error: ['FORBIDDEN', 'Browser session required']}
				const t = `url:${newToken()}`
				urlTokens.set(t, browser.get(token))
				return t
			},
		},
		'files.list': {
			kind: 'query',
			run: fsOp(({path, sortBy = 'name', sortOrder = 'ascending'}) => {
				needDir(path)
				const files = children(path).map(entry)
				const dirFirst = (a, b) => Number(b.type === 'directory') - Number(a.type === 'directory')
				files.sort((a, b) => dirFirst(a, b) || (sortBy === 'name' ? a.name.localeCompare(b.name) : (a[sortBy] ?? 0) - (b[sortBy] ?? 0)))
				if (sortOrder === 'descending') files.reverse()
				return {...entry(path), files, hasMore: false, totalFiles: files.length}
			}),
		},
		'files.search': {kind: 'query', run: ({query}) => [...fsTree.keys()].filter((k) => !k.startsWith('/Trash') && baseName(k).toLowerCase().includes(query.toLowerCase())).slice(0, 50).map(entry)},
		'files.recents': {kind: 'query', run: () => ['/Home/Documents/Notes.txt', '/Home/Photos/Sunset.jpg'].filter((p) => fsTree.has(p)).map(entry)},
		'files.favorites': {kind: 'query', run: () => [...favorites].filter((p) => fsTree.has(p))},
		'files.addFavorite': {kind: 'mutation', run: ({path}) => (favorites.add(path), true)},
		'files.removeFavorite': {kind: 'mutation', run: ({path}) => (favorites.delete(path), true)},
		'files.createDirectory': {kind: 'mutation', run: fsOp(({path}) => {
			needDir(parentOf(path))
			if (fsTree.has(path)) throw ['BAD_REQUEST', '[destination-already-exists]']
			fsTree.set(path, {type: 'directory', modified: Date.now()})
			return path
		})},
		'files.unarchive': {kind: 'mutation', run: fsOp(({path}) => {
			if (!fsTree.has(path)) throw ['NOT_FOUND', '[does-not-exist]']
			const to = uniqueIn(parentOf(path), baseName(path).replace(/\.(zip|tar\.gz|tgz|tar|7z|rar)$/i, ''))
			fsTree.set(to, {type: 'directory', modified: Date.now()})
			fsTree.set(`${to}/extracted.txt`, {type: 'text/plain', data: Buffer.from('extracted'), modified: Date.now()})
			return to
		})},
		'files.getThumbnail': {kind: 'mutation', run: fsOp(({path}) => {
			const v = fsTree.get(path)
			if (!v) throw ['NOT_FOUND', '[does-not-exist]']
			return `${baseName(path).replace(/\W/g, '')}.webp`
		})},
		'files.rename': {kind: 'mutation', run: fsOp(({path, newName}) => {
			if (!fsTree.has(path)) throw ['NOT_FOUND', '[does-not-exist]']
			const to = `${parentOf(path)}/${newName}`
			if (fsTree.has(to)) throw ['BAD_REQUEST', '[destination-already-exists]']
			moveTree(path, to, false)
			return to
		})},
		'files.copy': {kind: 'mutation', run: fsOp(({path, toDirectory}) => {
			needDir(toDirectory)
			const to = uniqueIn(toDirectory, baseName(path))
			moveTree(path, to, true)
			return to
		})},
		'files.move': {kind: 'mutation', run: fsOp(({path, toDirectory}) => {
			needDir(toDirectory)
			if (toDirectory === path || toDirectory.startsWith(`${path}/`)) throw ['BAD_REQUEST', '[subdir-of-self]']
			const to = uniqueIn(toDirectory, baseName(path))
			moveTree(path, to, false)
			return to
		})},
		'files.trash': {kind: 'mutation', run: fsOp(({path}) => {
			const to = uniqueIn('/Trash', baseName(path))
			moveTree(path, to, false)
			fsTree.get(to).from = parentOf(path)
			return to
		})},
		'files.restore': {kind: 'mutation', run: fsOp(({path}) => {
			const from = fsTree.get(path)?.from ?? '/Home'
			const to = uniqueIn(from, baseName(path))
			moveTree(path, to, false)
			return to
		})},
		'files.delete': {kind: 'mutation', run: ({path}) => (moveTree(path, '/dev/null', false), [...fsTree.keys()].filter((k) => k.startsWith('/dev/null')).forEach((k) => fsTree.delete(k)), true)},
		'files.emptyTrash': {kind: 'mutation', run: () => (children('/Trash').forEach((k) => [...fsTree.keys()].filter((x) => x === k || x.startsWith(`${k}/`)).forEach((x) => fsTree.delete(x))), true)},
		'files.operationProgress': {kind: 'query', run: () => []},
		'files.shares': {kind: 'query', run: () => smbShares},
		'files.addShare': {kind: 'mutation', run: ({path}) => (smbShares.push({name: baseName(path), path, available: true, sharename: baseName(path)}), true)},
		'files.removeShare': {kind: 'mutation', run: ({path}) => (smbShares.splice(smbShares.findIndex((x) => x.path === path), 1), true)},
		'files.sharePassword': {kind: 'query', run: () => 'k3x9-share-pass'},
		'files.externalDevices': {
			kind: 'query',
			run: () => usbDrives,
		},
		'files.unmountExternalDevice': {kind: 'mutation', run: ({deviceId}) => (usbDrives.splice(usbDrives.findIndex((d) => d.id === deviceId), 1), true)},
		'hardware.internalStorage.getDevices': {kind: 'query', run: () => storageDevices},
		'hardware.raid.getStatus': {kind: 'query', run: () => raid},
		'hardware.raid.addDevice': {
			kind: 'mutation',
			run: ({deviceId}) => {
				if (!raid.exists) throw new Error("RAID array doesn't exist")
				raid.devices.push({id: deviceId, status: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0})
				raid.usableSpace += 1e12
				raid.totalSpace += 1e12
				return true
			},
		},
		'hardware.raid.transitionToFailsafeRaidz': {kind: 'mutation', run: () => (raid.failsafeTransitionStatus = {state: 'syncing', progress: 12}, true)},
		'hardware.raid.replaceDevice': {
			kind: 'mutation',
			run: ({oldDevice, newDevice}) => {
				const m = raid.devices.find((d) => d.id === oldDevice)
				if (!m) throw new Error(`Device ${oldDevice} is not in the RAID array or accelerator`)
				Object.assign(m, {id: newDevice, status: 'ONLINE'})
				raid.status = 'ONLINE'
				raid.replace = {state: 'rebuilding', progress: 3}
				return true
			},
		},
		'hardware.raid.scrub': {kind: 'mutation', run: () => (raid.scrub = {state: 'scrubbing', progress: 1, errors: 0}, true)},
		'hardware.raid.addMirror': {kind: 'mutation', run: () => true},
		'hardware.raid.addAccelerator': {kind: 'mutation', run: () => true},
		'system.logs': {kind: 'query', run: ({type}) => `${type} log line 1\n${type} log line 2\n`},
	}

	// Storage hardware. Default: a single-drive Umbrel (no pool) with two spare disks attached.
	// FAKE_RAID=1: an SSD FailSafe (raidz) pool with one failed member and a spare SSD.
	const ssd = (id, name, size, extra = {}) => ({type: 'ssd', transport: 'sata', device: id.slice(-3), id, name, model: name, serial: `S${id.length}${id.slice(-4).toUpperCase()}`, size, roundedSize: size, temperature: 36, smartStatus: 'healthy', ...extra})
	const hdd = (id, name, size, extra = {}) => ({type: 'hdd', transport: 'sata', device: id.slice(-3), id, name, model: name, serial: `W${id.slice(-4).toUpperCase()}`, size, roundedSize: size, temperature: 33, smartStatus: 'healthy', ...extra})
	const storageDevices = process.env.FAKE_RAID
		? [
				ssd('sata-boot-sda', 'QEMU HARDDISK', 64e9, {isSystemDrive: true}),
				ssd('sata-samsung-870-sdb', 'Samsung SSD 870 EVO', 2e12, {isSystemDrive: false, lifetimeUsed: 4}),
				ssd('sata-samsung-870-sdc', 'Samsung SSD 870 EVO', 2e12, {isSystemDrive: false, smartStatus: 'unhealthy', temperature: 58}),
				ssd('sata-crucial-mx500-sdd', 'Crucial MX500', 2e12, {isSystemDrive: false}),
			]
		: [
				ssd('sata-boot-sda', 'QEMU HARDDISK', 256e9, {isSystemDrive: true}),
				hdd('sata-wd-red-sdb', 'WDC WD40EFRX', 4e12, {isSystemDrive: false}),
				hdd('sata-wd-red-sdc', 'WDC WD40EFRX', 4e12, {isSystemDrive: false}),
			]
	const raid = process.env.FAKE_RAID
		? {
				name: 'umbrelos-1a2b3c4d',
				exists: true,
				raidType: 'failsafe',
				topology: 'raidz',
				status: 'DEGRADED',
				totalSpace: 4e12,
				usableSpace: 2e12,
				usedSpace: 0.62e12,
				freeSpace: 1.38e12,
				devices: [
					{id: 'sata-samsung-870-sdb', status: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0},
					{id: 'sata-samsung-870-sdc', status: 'FAULTED', readErrors: 14, writeErrors: 3, checksumErrors: 0},
				],
				scrub: {state: 'finished', progress: 100, errors: 0},
			}
		: {name: undefined, exists: false}
	const usbDrives = [{id: 'sde', name: 'SanDisk Extreme', transport: 'usb', size: 1e12, partitions: [{id: 'sde1', label: 'BACKUP', size: 1e12, mountpoints: ['/External/BACKUP'], supportsAppDataRoot: false}]}]

	const appAuthChecks = []
	const server = http.createServer(async (req, res) => {
		const send = (status, body) => {
			res.writeHead(status, {'content-type': 'application/json'})
			res.end(JSON.stringify(body))
		}
		const fail = (code, message) => {
			const httpStatus = {UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, BAD_REQUEST: 400}[code] ?? 500
			send(httpStatus, {error: {message, code: -32000, data: {code, httpStatus, path: ''}}})
		}
		const url = new URL(req.url, 'http://x')
		if (url.pathname.startsWith('/api/files/')) return fileApi(req, res, url)
		// umbreld's app gateway sign-in check (/app-auth/v1/account/session). The fake
		// accepts the session token "good-app-session"; the app "private-notes" isn't shared.
		if (url.pathname === '/app-auth/v1/account/session') {
			appAuthChecks.push({app: url.searchParams.get('app'), cookie: req.headers.cookie ?? ''})
			const token = /(?:^|;\s*)UMBREL_APP_SESSION=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
			if (!appSessionTokens.has(token)) return send(401, {error: {code: -32001, message: 'Unauthorized'}})
			if (url.searchParams.get('app') === 'private-notes') return send(403, {error: {code: -32003, message: 'This app has not been shared with this account'}})
			return send(200, {url: 'http://x/umbrel_/api/v1/auth/handoff', params: {r: '/', handoff: 'h'}})
		}
		const wp = url.pathname.match(/^\/assets\/wallpapers\/(\d+)\.jpg$/)
		if (wp) {
			try {
				const data = await readFile(`${wallpaperDir ?? '/nonexistent'}/${wp[1]}.jpg`)
				res.writeHead(200, {'content-type': 'image/jpeg'})
				return res.end(data)
			} catch {
				res.writeHead(404)
				return res.end()
			}
		}
		const path = url.pathname.replace(/^\/trpc\//, '')
		const proc = procedures[path]
		if (!url.pathname.startsWith('/trpc/') || !proc) return fail('NOT_FOUND', `No procedure found on path "${path}"`)
		if ((proc.kind === 'query') !== (req.method === 'GET')) return fail('METHOD_NOT_SUPPORTED', 'Wrong method')
		let input
		if (req.method === 'GET') {
			const raw = url.searchParams.get('input')
			input = raw === null ? undefined : JSON.parse(raw)
		} else {
			let body = ''
			for await (const chunk of req) body += chunk
			input = body ? JSON.parse(body) : undefined
		}
		calls.push({path, input, authorization: req.headers.authorization, userAgent: req.headers['user-agent']})
		let auth = null
		if (!proc.public) {
			const [scheme, token] = req.headers.authorization?.split(' ') ?? []
			const record = scheme === 'Bearer' && tokens.get(token)
			if (!record || record.expiresAt <= Date.now()) return fail('UNAUTHORIZED', 'Invalid token')
			auth = record
		}
		const out = proc.run(input, auth, res, req)
		if (out?.notFound) return fail('NOT_FOUND', `No procedure found on path "${path}"`)
		if (Array.isArray(out?.error)) return fail(...out.error)
		send(200, {result: {data: out}})
	})

	// /api/files/*: like umbreld, reads need the browser cookie + URL token; uploads need Bearer + cookie.
	const cookieOf = (req) => /UMBREL_BROWSER_SESSION=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
	async function fileApi(req, res, url) {
		const end = (status, body, headers = {}) => {
			res.writeHead(status, headers)
			res.end(body)
		}
		const kind = url.pathname.split('/')[3]
		if (req.method === 'POST' && kind === 'upload') {
			const token = req.headers.authorization?.split(' ')[1]
			if (!browser.get(token) || browser.get(token) !== cookieOf(req)) return end(401, '{"error":"unauthorized"}')
			const path = url.searchParams.get('path')
			const dir = parentOf(path)
			if (fsTree.get(dir)?.type !== 'directory') return end(404, '{"error":"not found"}')
			const chunks = []
			for await (const c of req) chunks.push(c)
			const replace = url.searchParams.get('collision') === 'replace' && fsTree.get(path)?.type !== 'directory'
			const target = fsTree.has(path) && !replace ? uniqueIn(dir, baseName(path)) : path
			const type = fsTree.get(target)?.type ?? typeFor(baseName(target))
			fsTree.set(target, {type, data: Buffer.concat(chunks), modified: Date.now()})
			return end(200, JSON.stringify({path: target}), {'content-type': 'application/json'})
		}
		const t = url.searchParams.get('token')
		if (req.method !== 'GET' || !urlTokens.get(t) || urlTokens.get(t) !== cookieOf(req)) return end(401, '{"error":"unauthorized"}')
		const paths = url.searchParams.getAll('path')
		const v = fsTree.get(paths[0])
		if (!v) return end(404, '{"error":"not found"}')
		let data = v.data
		if (kind === 'thumbnail' && v.type === 'image/heic' && wallpaperDir) data = await readFile(`${wallpaperDir}/9.jpg`).catch(() => null)
		if (!data && v.wallpaper && wallpaperDir) data = await readFile(`${wallpaperDir}/${v.wallpaper}.jpg`).catch(() => null)
		if (!data) data = Buffer.alloc(Math.min(sizeOf(v), 1024))
		if (kind === 'download' && (paths.length > 1 || v.type === 'directory')) {
			return end(200, Buffer.from('PK fake zip'), {'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''umbrel-files.zip`})
		}
		const headers = {'content-type': v.type === 'directory' ? 'application/octet-stream' : kind === 'thumbnail' && v.type === 'image/heic' ? 'image/jpeg' : v.type, 'content-length': String(data.length)}
		if (kind === 'download') headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(baseName(paths[0]))}`
		return end(200, data, headers)
	}

	// /machines/console: single-use ticket in the query, then a raw VNC (RFB 3.8) stream,
	// as umbreld bridges from QEMU. This minimal server draws one test frame and records keys.
	const wss = new WebSocketServer({noServer: true})
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, 'http://x')
		const ticket = url.searchParams.get('ticket')
		if (url.pathname === '/terminal') {
			if (!ticket?.startsWith('terminal:') || !tickets.delete(ticket)) return socket.destroy()
			terminals.push({appId: url.searchParams.get('appId'), cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows'))})
			return wss.handleUpgrade(req, socket, head, (ws) => shellServer(ws, url.searchParams.get('appId'), keys))
		}
		if (url.pathname !== '/machines/console' || !ticket?.startsWith('machines:') || !tickets.delete(ticket) || !url.searchParams.get('machineId') || !url.searchParams.get('sessionId')) {
			return socket.destroy()
		}
		wss.handleUpgrade(req, socket, head, (ws) => rfbServer(ws, keys))
	})

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			baseUrl = `http://127.0.0.1:${server.address().port}`
			resolve({
				url: `http://127.0.0.1:${server.address().port}`,
				calls,
				keys,
				terminals,
				settings,
				lastCreate: () => lastCreate,
				fsTree,
				apps,
				appAuthChecks,
				appRequests,
				expireAllAccessTokens: () => {
					for (const v of tokens.values()) v.expiresAt = 0
				},
				revokeAllDevices: () => {
					devices.clear()
					tokens.clear()
				},
				close: () => Promise.all([new Promise((r) => server.close(r)), ...appServers.map((x) => new Promise((r) => x.close(r)))]),
			})
		})
	})
}

// A tiny line-based shell standing in for umbreld's PTY: echoes input, answers a few commands.
function shellServer(ws, appId, log) {
	const prompt = appId ? '$ ' : '\x1b[1;32mumbrel@umbrel\x1b[0m:\x1b[1;34m~\x1b[0m$ '
	let line = ''
	ws.send(appId ? '' : 'Welcome to umbrelOS (test shell)\r\n\r\n')
	ws.send(prompt)
	ws.on('message', (data) => {
		for (const ch of data.toString()) {
			log.push({term: ch})
			if (ch === '\r') {
				ws.send('\r\n')
				const cmd = line.trim()
				if (cmd === 'uname -a') ws.send('Linux umbrel 6.12.0-umbrel x86_64 GNU/Linux\r\n')
				else if (cmd === 'docker ps') ws.send('CONTAINER ID   IMAGE                  NAMES\r\na1b2c3d4e5f6   ghcr.io/immich:v1.120   immich_server_1\r\n')
				else if (cmd) ws.send(`${cmd.split(' ')[0]}: ran\r\n`)
				line = ''
				ws.send(prompt)
			} else if (ch === '\x7f') {
				if (line) {
					line = line.slice(0, -1)
					ws.send('\b \b')
				}
			} else if (ch === '\x03') {
				line = ''
				ws.send('^C\r\n' + prompt)
			} else if (ch >= ' ') {
				line += ch
				ws.send(ch)
			}
		}
	})
}

function rfbServer(ws, keys) {
	const W = 640
	const H = 400
	let buf = Buffer.alloc(0)
	let stage = 'version'
	let sent = false
	ws.send(Buffer.from('RFB 003.008\n'))
	const frame = () => {
		const head = Buffer.alloc(16)
		head.writeUInt8(0, 0) // FramebufferUpdate
		head.writeUInt16BE(1, 2) // one rectangle
		head.writeUInt16BE(0, 4)
		head.writeUInt16BE(0, 6)
		head.writeUInt16BE(W, 8)
		head.writeUInt16BE(H, 10)
		head.writeInt32BE(0, 12) // raw
		const px = Buffer.alloc(W * H * 4)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4
				const bar = y < 28
				px[i] = bar ? 48 : 119 - Math.round((y / H) * 60)
				px[i + 1] = bar ? 10 : 33 + Math.round((x / W) * 30)
				px[i + 2] = bar ? 36 : 111 - Math.round((y / H) * 40)
				px[i + 3] = 255
			}
		ws.send(Buffer.concat([head, px]))
	}
	ws.on('message', (data) => {
		buf = Buffer.concat([buf, data])
		for (;;) {
			if (stage === 'version') {
				if (buf.length < 12) return
				buf = buf.subarray(12)
				ws.send(Buffer.from([1, 1])) // one security type: None
				stage = 'security'
			} else if (stage === 'security') {
				if (buf.length < 1) return
				buf = buf.subarray(1)
				ws.send(Buffer.from([0, 0, 0, 0])) // SecurityResult OK
				stage = 'init'
			} else if (stage === 'init') {
				if (buf.length < 1) return
				buf = buf.subarray(1)
				const name = Buffer.from('Ubuntu Desktop (test)')
				const init = Buffer.alloc(24)
				init.writeUInt16BE(W, 0)
				init.writeUInt16BE(H, 2)
				Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4)
				init.writeUInt32BE(name.length, 20)
				ws.send(Buffer.concat([init, name]))
				stage = 'run'
			} else {
				if (buf.length < 1) return
				const type = buf[0]
				let len
				if (type === 0) len = 20
				else if (type === 2) len = buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity
				else if (type === 3) len = 10
				else if (type === 4) len = 8
				else if (type === 5) len = 6
				else if (type === 6) len = buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity
				else return ws.close()
				if (buf.length < len) return
				if (type === 4 && buf[1] === 1) keys.push(buf.readUInt32BE(4))
				if (type === 5) keys.push({mask: buf[1], x: buf.readUInt16BE(2), y: buf.readUInt16BE(4)})
				if (type === 3 && !sent) {
					sent = true
					frame()
				}
				buf = buf.subarray(len)
			}
		}
	})
}

// `node test/fake-umbreld.mjs 7781` runs it standalone for UI development.
if (import.meta.url === `file://${process.argv[1]}`) {
	const fake = await startFakeUmbreld({port: Number(process.argv[2] ?? 7781)})
	console.log(`fake umbreld (TEST ONLY) at ${fake.url}, password "correct horse"`)
	// Lets a browser test read which keys reached the fake VM.
	process.on('SIGUSR2', () => console.log('KEYS ' + JSON.stringify(fake.keys)))
}
