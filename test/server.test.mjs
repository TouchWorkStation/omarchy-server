import assert from 'node:assert/strict'
import {mkdtemp, readFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeUmbreld} from './fake-umbreld.mjs'

async function startTouch({umbrelUrl, appHosts} = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'touch-'))
	const store = await createStore(dir)
	if (umbrelUrl) await store.setConfig({umbrelUrl})
	if (appHosts) await store.setConfig({appHosts})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(server)
	const base = `http://127.0.0.1:${server.address().port}`
	let cookie = ''
	const req = async (method, path, body, headers = {}) => {
		const res = await fetch(base + path, {
			method,
			headers: {
				...(body !== undefined ? {'content-type': 'application/json'} : {}),
				...(method !== 'GET' ? {'x-umbrel-touch': '1'} : {}),
				...(cookie ? {cookie} : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		})
		const set = res.headers.get('set-cookie')
		if (set) cookie = set.split(';')[0]
		return {status: res.status, body: await res.json().catch(() => null), setCookie: set}
	}
	return {dir, store, base, req, getCookie: () => cookie, close: () => (app.closeRelays(), new Promise((r) => server.close(r)))}
}

describe('UmbrelOS Touch server against an umbreld 2.0 stand-in', () => {
	let fake
	let touch
	before(async () => {
		fake = await startFakeUmbreld({accessTtlMs: 60 * 60 * 1000})
		touch = await startTouch()
	})
	after(async () => {
		await touch.close()
		await fake.close()
	})

	test('unconfigured server asks to connect, setup verifies the address is umbrelOS', async () => {
		let r = await touch.req('GET', '/api/bootstrap')
		assert.equal(r.body.configured, false)
		r = await touch.req('POST', '/api/setup', {url: 'http://127.0.0.1:1'})
		assert.equal(r.status, 502)
		r = await touch.req('POST', '/api/setup', {url: fake.url})
		assert.equal(r.status, 200)
		assert.equal(r.body.version, '2.0.0')
		r = await touch.req('GET', '/api/bootstrap')
		assert.equal(r.body.umbrel.reachable, true)
		// a loopback Umbrel address is reported as the address the phone used to reach Touch
		assert.equal(r.body.umbrel.host, '127.0.0.1')
		assert.equal(r.body.umbrel.url, 'http://127.0.0.1')
		// before sign-in nothing identifies the accounts; only the backdrop wallpaper is shared
		assert.deepEqual(r.body.accounts, [{userId: '', name: '', avatar: null, wallpaper: {id: '23', brandColorHsl: '24 90% 50%'}}])
		assert.equal(r.body.session, null)
	})

	test('wallpaper route only serves numeric umbrelOS wallpaper ids', async () => {
		const bad = await fetch(`${touch.base}/api/umbrel-wallpaper/..%2F..%2Fetc`)
		assert.equal(bad.status, 404)
		const missing = await fetch(`${touch.base}/api/umbrel-wallpaper/999`)
		assert.equal(missing.status, 404)
	})

	test('proxy refuses calls before sign-in', async () => {
		const r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 401)
	})

	test('wrong password surfaces umbreld’s message', async () => {
		// username and password are both required, and a wrong one of either reads the same
		let r = await touch.req('POST', '/api/auth/login', {password: 'correct horse'})
		assert.equal(r.status, 400)
		r = await touch.req('POST', '/api/auth/login', {username: 'chris', password: 'nope'})
		assert.equal(r.status, 401)
		assert.equal(r.body.error.message, 'Incorrect username or password')
		r = await touch.req('POST', '/api/auth/login', {username: 'admin', password: 'correct horse'})
		assert.equal(r.status, 401)
		assert.equal(r.body.error.message, 'Incorrect username or password')
	})

	test('native login stores credentials server-side and sets only an opaque cookie', async () => {
		const r = await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'}, {'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'})
		assert.equal(r.status, 200)
		assert.equal(r.body.mode, 'native')
		assert.match(r.setCookie, /HttpOnly/)
		assert.match(r.setCookie, /SameSite=Strict/)
		const login = fake.calls.findLast((c) => c.path === 'user.loginNative')
		assert.deepEqual(login.input.client, {id: 'umbrel-touch', platform: 'ios', deviceClass: 'phone', appVersion: '0.15.1', appBuild: '1', osVersion: 'web'})
		const saved = await readFile(join(touch.dir, 'sessions.json'), 'utf8')
		assert.ok(!saved.includes(touch.getCookie().split('=')[1]), 'cookie value must not be stored in plain form')
		assert.equal((await stat(join(touch.dir, 'sessions.json'))).mode & 0o777, 0o600)
	})

	test('queries and mutations go through with the bearer token', async () => {
		let r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 200)
		assert.equal(r.body.data.length, 4)
		r = await touch.req('GET', `/api/rpc/apps.state?input=${encodeURIComponent(JSON.stringify({appId: 'jellyfin'}))}`)
		assert.equal(r.body.data.state, 'stopped')
		r = await touch.req('POST', '/api/rpc/apps.start', {input: {appId: 'jellyfin'}})
		assert.equal(r.status, 200)
		assert.equal(fake.apps.find((a) => a.id === 'jellyfin').state, 'ready')
		assert.match(fake.calls.findLast((c) => c.path === 'apps.start').authorization, /^Bearer /)
	})

	const openConsole = (headers) =>
		new Promise((resolve) => {
			const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/console?machineId=ubuntu-1`, {headers})
			ws.once('message', (data) => {
				resolve({ok: true, first: data.toString()})
				ws.close()
			})
			ws.once('unexpected-response', (_req, res) => resolve({ok: false, status: res.statusCode}))
			ws.once('error', () => resolve({ok: false}))
		})

	test('VM console: bridges VNC through a server-held browser session', async () => {
		const r = await touch.req('GET', '/api/console/check')
		assert.equal(r.status, 200)
		const ok = await openConsole({cookie: touch.getCookie(), origin: touch.base})
		assert.deepEqual(ok, {ok: true, first: 'RFB 003.008\n'})
		// the ticket was requested with the dashboard token + browser cookie, never the native token
		const ticketCall = fake.calls.findLast((c) => c.path === 'user.createWebSocketTicket')
		assert.deepEqual(ticketCall.input, {target: 'machines'})
		const native = fake.calls.findLast((c) => c.path === 'apps.list' || c.path === 'user.get')
		assert.notEqual(ticketCall.authorization, native?.authorization)
	})

	test('VM console: refuses other sites, missing sign-in and odd machine ids', async () => {
		assert.equal((await openConsole({cookie: touch.getCookie(), origin: 'http://evil.example'})).status, 403)
		assert.equal((await openConsole({cookie: touch.getCookie()})).status, 403)
		assert.equal((await openConsole({origin: touch.base})).status, 401)
		const bad = await new Promise((resolve) => {
			const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/console?machineId=../x`, {headers: {cookie: touch.getCookie(), origin: touch.base}})
			ws.once('unexpected-response', (_q, res) => resolve(res.statusCode))
			ws.once('error', () => resolve(0))
		})
		assert.equal(bad, 400)
	})

	test('creates a machine through umbreld', async () => {
		const r = await touch.req('POST', '/api/rpc/machines.create', {input: {name: 'Dev box', osId: 'debian-server-amd64', cores: 2, memoryGb: 2, diskSizeGb: 15, arch: 'amd64', username: 'chris', password: 'pw'}})
		assert.equal(r.status, 200)
		assert.equal(r.body.data.state, 'installing')
		assert.equal(fake.lastCreate().username, 'chris')
	})

	test('settings calls go through', async () => {
		assert.equal((await touch.req('POST', '/api/rpc/system.setHostname', {input: {hostname: 'nest'}})).status, 200)
		assert.equal(fake.settings.hostname, 'nest')
		assert.equal((await touch.req('POST', '/api/rpc/apps.setTorEnabled', {input: true})).status, 200)
		assert.equal(fake.settings.tor, true)
		const wrong = await touch.req('POST', '/api/rpc/user.changePassword', {input: {oldPassword: 'nope', newPassword: 'abcdefg'}})
		assert.equal(wrong.status, 401)
		const sessions = await touch.req('GET', '/api/rpc/user.listSessions')
		assert.equal(sessions.body.data.length, 2)
	})

	test('theme settings are saved per account and validated', async () => {
		let r = await touch.req('POST', '/api/prefs', {theme: 'tokyo', accent: 'teal'})
		assert.equal(r.status, 200)
		r = await touch.req('GET', '/api/prefs')
		assert.equal(r.body.prefs.theme, 'tokyo')
		assert.equal(r.body.prefs.accent, 'teal')
		assert.equal((await touch.req('POST', '/api/prefs', {theme: '<script>'})).status, 400)
		assert.equal((await touch.req('POST', '/api/prefs', {customBrandHsl: 'red; x'})).status, 400)
		const anon = await fetch(`${touch.base}/api/prefs`)
		assert.equal(anon.status, 401)
	})

	test('custom background upload accepts JPEG only and is private', async () => {
		const send = (body) =>
			fetch(`${touch.base}/api/background`, {method: 'POST', headers: {'content-type': 'image/jpeg', 'x-umbrel-touch': '1', cookie: touch.getCookie()}, body})
		assert.equal((await send(Buffer.from('<svg onload=alert(1)>'))).status, 400)
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
		const up = await send(jpeg)
		assert.equal(up.status, 200)
		assert.ok((await up.json()).prefs.backgroundVersion)
		const got = await fetch(`${touch.base}/api/background`, {headers: {cookie: touch.getCookie()}})
		assert.equal(got.status, 200)
		assert.equal(got.headers.get('content-type'), 'image/jpeg')
		assert.equal((await fetch(`${touch.base}/api/background`)).status, 401)
		const del = await touch.req('DELETE', '/api/background')
		assert.equal(del.body.prefs.backgroundVersion, null)
	})

	test('terminal: bridges a shell (and an app shell) with a terminal ticket', async () => {
		const open = (q) =>
			new Promise((resolve) => {
				const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/terminal?${q}`, {headers: {cookie: touch.getCookie(), origin: touch.base}})
				let out = ''
				ws.on('message', (d) => {
					out += d.toString()
					if (out.includes('$ ') && !out.includes('ran')) ws.send('ls\r')
					if (out.includes('ls: ran')) {
						ws.close()
						resolve({ok: true, out})
					}
				})
				ws.once('unexpected-response', (_q, res) => resolve({ok: false, status: res.statusCode}))
			})
		const shell = await open('cols=80&rows=24')
		assert.ok(shell.ok)
		assert.match(shell.out, /Welcome to umbrelOS/)
		const appShell = await open('appId=immich&cols=60&rows=20')
		assert.ok(appShell.ok)
		assert.deepEqual(fake.terminals.at(-1), {appId: 'immich', cols: 60, rows: 20})
		assert.equal((await open('appId=../x&cols=80&rows=24')).status, 400)
		assert.equal((await open('cols=5000&rows=24')).status, 400)
	})

	test('files: list, upload, download and preview through the server', async () => {
		const list = await touch.req('GET', `/api/rpc/files.list?input=${encodeURIComponent(JSON.stringify({path: '/Home/Documents'}))}`)
		assert.equal(list.status, 200)
		assert.ok(list.body.data.files.some((f) => f.name === 'Notes.txt'))
		const up = await fetch(`${touch.base}/api/files/upload?path=${encodeURIComponent('/Home/Documents/hello.txt')}`, {
			method: 'POST',
			headers: {cookie: touch.getCookie(), 'x-umbrel-touch': '1', 'content-type': 'application/octet-stream'},
			body: 'uploaded from the phone',
		})
		assert.equal(up.status, 200)
		assert.equal((await up.json()).path, '/Home/Documents/hello.txt')
		const down = await fetch(`${touch.base}/api/files/download?path=${encodeURIComponent('/Home/Documents/hello.txt')}`, {headers: {cookie: touch.getCookie()}})
		assert.equal(down.status, 200)
		assert.equal(await down.text(), 'uploaded from the phone')
		assert.match(down.headers.get('content-disposition'), /hello\.txt/)
		const view = await fetch(`${touch.base}/api/files/view?path=${encodeURIComponent('/Home/Documents/Notes.txt')}`, {headers: {cookie: touch.getCookie()}})
		assert.equal(view.status, 200)
		assert.match(view.headers.get('content-security-policy'), /sandbox/)
		// cross-site upload refused, signed-out download refused
		const csrf = await fetch(`${touch.base}/api/files/upload?path=%2FHome%2Fx.txt`, {method: 'POST', headers: {cookie: touch.getCookie()}, body: 'x'})
		assert.equal(csrf.status, 403)
		assert.equal((await fetch(`${touch.base}/api/files/download?path=%2FHome%2FDocuments%2FNotes.txt`)).status, 401)
		const mv = await touch.req('POST', '/api/rpc/files.move', {input: {path: '/Home/Documents/hello.txt', toDirectory: '/Home/Downloads'}})
		assert.equal(mv.status, 200)
		assert.ok(fake.fsTree.has('/Home/Downloads/hello.txt'))
	})

	test('community app stores can be listed, added and removed', async () => {
		const url = 'https://github.com/TouchWorkStation/app-store'
		const add = await touch.req('POST', '/api/rpc/appStore.addRepository', {input: {url}})
		assert.equal(add.status, 200)
		const list = await touch.req('GET', '/api/rpc/appStore.repositories')
		assert.ok(list.body.data.some((r) => r.url === url && r.meta.id === 'touchworkstation'))
		const reg = await touch.req('GET', '/api/rpc/appStore.registry')
		assert.ok(reg.body.data.some((r) => r.apps.some((a) => a.id === 'touchworkstation-chrome')))
		const dup = await touch.req('POST', '/api/rpc/appStore.addRepository', {input: {url}})
		assert.notEqual(dup.status, 200)
		const rm = await touch.req('POST', '/api/rpc/appStore.removeRepository', {input: {url}})
		assert.equal(rm.status, 200)
	})

	test('file viewer: saves edits in place, extracts archives, asks for renditions', async () => {
		const save = await fetch(`${touch.base}/api/files/upload?path=${encodeURIComponent('/Home/Documents/Notes.txt')}&collision=replace`, {
			method: 'POST',
			headers: {cookie: touch.getCookie(), 'x-umbrel-touch': '1', 'content-type': 'application/octet-stream'},
			body: 'edited in the viewer',
		})
		assert.equal(save.status, 200)
		assert.equal((await save.json()).path, '/Home/Documents/Notes.txt')
		assert.equal(fake.fsTree.get('/Home/Documents/Notes.txt').data.toString(), 'edited in the viewer')
		const un = await touch.req('POST', '/api/rpc/files.unarchive', {input: {path: '/Home/backup.zip'}})
		assert.equal(un.status, 200)
		assert.ok(fake.fsTree.has('/Home/backup'))
		const th = await touch.req('POST', '/api/rpc/files.getThumbnail', {input: {path: '/Home/Photos/Lake.jpg', variant: 'preview-1280-webp-v2'}})
		assert.equal(th.status, 200)
		assert.equal(typeof th.body.data, 'string')
	})

	test('non-allowlisted procedures are refused without reaching umbreld', async () => {
		const before = fake.calls.length
		const r = await touch.req('POST', '/api/rpc/user.deleteUser', {input: {userId: 'x'}})
		assert.equal(r.status, 404)
		assert.equal(fake.calls.length, before)
	})

	test('storage: drives and pool status pass through; RAID setup is never reachable', async () => {
		const devices = await touch.req('GET', '/api/rpc/hardware.internalStorage.getDevices')
		assert.equal(devices.status, 200)
		assert.ok(devices.body.data.some((d) => d.isSystemDrive))
		const raid = await touch.req('GET', '/api/rpc/hardware.raid.getStatus')
		assert.equal(raid.status, 200)
		assert.equal(raid.body.data.exists, false)
		const before = fake.calls.length
		const setup = await touch.req('POST', '/api/rpc/hardware.raid.setup', {input: {devices: ['a'], raidType: 'storage'}})
		assert.equal(setup.status, 404)
		assert.equal(fake.calls.length, before)
	})

	test('desktop windows may frame only the Umbrel host, and the Host header can’t inject CSP', async () => {
		const {request} = await import('node:http')
		const cspFor = (host) =>
			new Promise((resolve, reject) => {
				const u = new URL(touch.base)
				const r = request({host: u.hostname, port: u.port, path: '/api/bootstrap', headers: {host}}, (res) => {
					res.resume()
					resolve(res.headers['content-security-policy'] ?? '')
				})
				r.on('error', reject)
				r.end()
			})
		assert.match(await cspFor('192.168.1.50:7780'), /frame-src 'self' http:\/\/192\.168\.1\.50:\* https:\/\/192\.168\.1\.50:\*;/)
		const evil = await cspFor('x.com;script-src *')
		assert.doesNotMatch(evil, /script-src \*/)
		assert.doesNotMatch(evil, /frame-src/)
	})

	test('app windows: reports whether the browser’s umbrelOS app session is valid, never the session itself', async () => {
		const ask = (app, extra) => touch.req('GET', `/api/app-access?app=${app}`, undefined, {cookie: `${touch.getCookie()}${extra}`})
		// a malformed cookie from another app on the same host must not break anything
		let r = await ask('nextcloud', '; junk=%E0%A4%A')
		assert.equal(r.status, 200)
		assert.deepEqual(r.body, {state: 'signin'})
		r = await ask('nextcloud', '; UMBREL_APP_SESSION=expired')
		assert.deepEqual(r.body, {state: 'signin'})
		r = await ask('nextcloud', '; UMBREL_APP_SESSION=good-app-session')
		assert.deepEqual(r.body, {state: 'ok'})
		r = await ask('private-notes', '; UMBREL_APP_SESSION=good-app-session')
		assert.deepEqual(r.body, {state: 'not-shared'})
		const check = fake.appAuthChecks.at(-1)
		assert.equal(check.app, 'private-notes')
		assert.equal(check.cookie, 'UMBREL_APP_SESSION=good-app-session') // only the app cookie is forwarded
		assert.equal((await touch.req('GET', '/api/app-access?app=../../x')).status, 400)
		const out = await fetch(`${touch.base}/api/app-access?app=nextcloud`, {headers: {cookie: 'UMBREL_APP_SESSION=good-app-session'}})
		assert.equal(out.status, 401) // needs a Touch session too
	})

	test('desktop: every app opens in a window through a relay, using Touch’s own umbrelOS app session', async () => {
		const r = await touch.req('GET', '/api/app-frame?apps=immich,nextcloud,home-assistant,../x')
		assert.equal(r.status, 200)
		assert.equal(r.body.sso, true) // the sign-in kept umbrelOS's app session server-side
		assert.deepEqual(r.body.results, {immich: 'window', nextcloud: 'window', 'home-assistant': 'window'})
		assert.deepEqual(r.body.relay, {immich: true, nextcloud: true, 'home-assistant': true})
		const open = await touch.req('GET', '/api/app-open?app=nextcloud')
		assert.equal(open.status, 200)
		const url = new URL(open.body.url)
		const via = (path, cookie) => fetch(new URL(path, url), {headers: cookie ? {cookie} : {}, redirect: 'manual'})
		// only browsers signed in to Touch get through
		assert.equal((await via('/', 'UMBREL_APP_SESSION=good-app-session')).status, 401)
		// no umbrelOS app sign-in needed in the browser: Touch supplies its own app session
		const page = await via('/', touch.getCookie())
		assert.equal(page.status, 200)
		assert.match(await page.text(), /Nextcloud/)
		assert.equal(page.headers.get('x-frame-options'), null)
		assert.equal(page.headers.get('content-security-policy'), `frame-ancestors 'self' ${touch.base}`)
		const ha = await touch.req('GET', '/api/app-open?app=home-assistant')
		const hap = await fetch(ha.body.url, {headers: {cookie: touch.getCookie()}})
		assert.equal(hap.headers.get('content-security-policy'), `frame-ancestors 'self' ${touch.base}`)
		// a frameable app's own redirect stays on the relay
		const im = await touch.req('GET', '/api/app-open?app=immich')
		const imr = await fetch(im.body.url, {headers: {cookie: touch.getCookie()}, redirect: 'manual'})
		assert.equal(imr.status, 302)
		assert.equal(new URL(imr.headers.get('location'), im.body.url).port, new URL(im.body.url).port)
		// Touch's own cookie never reaches an app
		assert.ok(fake.appRequests.length > 0)
		assert.ok(!fake.appRequests.some((c) => c.includes('umbrel_touch_sid')))
		assert.equal((await via('/__touch/ping.gif')).headers.get('content-type'), 'image/gif')
		assert.equal((await touch.req('GET', '/api/app-open?app=../x')).status, 400)
		assert.equal((await fetch(`${touch.base}/api/app-frame?apps=immich`)).status, 401)
	})

	test('remote access: app subdomains get a one-time hand-over, then a per-app cookie', async () => {
		const {request} = await import('node:http')
		const touch2 = await startTouch({umbrelUrl: fake.url, appHosts: '{app}-touch.example.com'})
		try {
			await touch2.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})
			const u = new URL(touch2.base)
			const get = (host, path, headers = {}) =>
				new Promise((resolve, reject) => {
					const q = request({host: u.hostname, port: u.port, path, headers: {host, ...headers}}, (res) => {
						let body = ''
						res.on('data', (c) => (body += c))
						res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}))
					})
					q.on('error', reject)
					q.end()
				})
			// the Touch page, as reached through the tunnel
			const open = await get('touch.example.com', '/api/app-open?app=nextcloud', {cookie: touch2.getCookie(), 'x-forwarded-proto': 'https'})
			const body = JSON.parse(open.body)
			assert.match(body.url, /^https:\/\/nextcloud-touch\.example\.com\/__touch\/enter\?t=/)
			const enter = new URL(body.url)
			// nothing gets through without the hand-over
			assert.equal((await get('nextcloud-touch.example.com', '/')).status, 401)
			const handed = await get('nextcloud-touch.example.com', enter.pathname + enter.search, {'x-forwarded-proto': 'https'})
			assert.equal(handed.status, 302)
			const cookie = handed.headers['set-cookie'][0]
			assert.match(cookie, /^__touch_app=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/)
			// the ticket is single use
			assert.equal((await get('nextcloud-touch.example.com', enter.pathname + enter.search)).status, 401)
			const page = await get('nextcloud-touch.example.com', '/', {cookie: cookie.split(';')[0]})
			assert.equal(page.status, 200)
			assert.match(page.body, /Nextcloud/)
			assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self' https://touch.example.com")
			// a per-app cookie doesn't open other apps
			assert.equal((await get('immich-touch.example.com', '/', {cookie: cookie.split(';')[0]})).status, 401)
			// Touch's own pages allow framing its app subdomains
			const csp = (await get('touch.example.com', '/api/bootstrap')).headers['content-security-policy']
			assert.match(csp, /frame-src [^;]*https:\/\/\*\.example\.com/)
		} finally {
			await touch2.close()
		}
	})

	test('wrong HTTP method for a procedure kind is refused', async () => {
		const r = await touch.req('GET', '/api/rpc/apps.start')
		assert.equal(r.status, 405)
	})

	test('cross-site POSTs are refused', async () => {
		let r = await touch.req('POST', '/api/rpc/apps.stop', {input: {appId: 'jellyfin'}}, {'x-umbrel-touch': ''})
		assert.equal(r.status, 403)
		r = await touch.req('POST', '/api/rpc/apps.stop', {input: {appId: 'jellyfin'}}, {origin: 'http://evil.example'})
		assert.equal(r.status, 403)
		assert.equal(fake.apps.find((a) => a.id === 'jellyfin').state, 'ready')
	})

	test('an expired access token is refreshed with the device token and the call retried', async () => {
		fake.expireAllAccessTokens()
		const r = await touch.req('GET', '/api/rpc/system.cpuUsage')
		assert.equal(r.status, 200)
		assert.equal(r.body.data.totalUsed, 18.4)
		assert.ok(fake.calls.some((c) => c.path === 'user.refreshNativeAccess'))
	})

	test('re-pointing the server needs a signed-in session', async () => {
		const anon = await fetch(`${touch.base}/api/setup`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-umbrel-touch': '1'},
			body: JSON.stringify({url: 'http://192.0.2.1'}),
		})
		assert.equal(anon.status, 403)
	})

	test('revoking the device in umbrelOS signs the phone out', async () => {
		fake.revokeAllDevices()
		const r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 401)
		assert.equal(touch.store.sessionCount(), 0)
		const b = await touch.req('GET', '/api/bootstrap')
		assert.equal(b.body.session, null)
	})

	test('logout revokes the umbrelOS session', async () => {
		await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})
		const r = await touch.req('POST', '/api/auth/logout')
		assert.equal(r.status, 200)
		assert.ok(fake.calls.findLast((c) => c.path === 'user.logout'))
		assert.equal(touch.store.sessionCount(), 0)
	})
})

describe('older umbrelOS without native login', () => {
	test('falls back to user.login bearer tokens', async () => {
		const fake = await startFakeUmbreld({legacy: true})
		const touch = await startTouch({umbrelUrl: fake.url})
		try {
			const r = await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})
			assert.equal(r.status, 200)
			assert.equal(r.body.mode, 'legacy')
			const list = await touch.req('GET', '/api/rpc/apps.list')
			assert.equal(list.status, 200)
		} finally {
			await touch.close()
			await fake.close()
		}
	})
})
