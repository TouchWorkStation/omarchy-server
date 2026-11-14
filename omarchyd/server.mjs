// omarchyd: the Omarchy Server backend. It listens on localhost only; the Touch web server in front
// of it is the one thing that faces the network. Runs as the owner's own user, not root.
import {mkdir, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import http from 'node:http'
import {fileURLToPath} from 'node:url'
import net from 'node:net'
import os from 'node:os'
import {dirname, extname, join} from 'node:path'

import {openAccounts} from './accounts.mjs'
import {APP_COOKIE, createApps} from './apps.mjs'
import {createFiles} from './files.mjs'
import {createMachines} from './machines.mjs'
import {createOmarchyTheme} from './omarchy-theme.mjs'
import {createStorage} from './storage.mjs'
import {bridge, openShell} from './terminal.mjs'
import {createUpdater} from './updater.mjs'
import {authorityInfo, readPolicy, rotateAuthority, tlsContext, writePolicy} from './tls.mjs'
import {RpcError, handleRpc, sendError, sendJson} from './rpc.mjs'
import * as system from './system.mjs'
import {WebSocketServer} from 'ws'

export const OMARCHYD_VERSION = '0.9.11'

export async function startOmarchyd({port = 2021, host = '127.0.0.1', dataDir, home = os.homedir(), webPort = 7780, machineOptions = {}, appOptions = {}, storageOptions = {}, updaterOptions = {}, desktopVncPort = 5900, desktopVncSocket = join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`, 'omarchy-server', 'desktop-vnc.sock')}) {
	const accounts = await openAccounts(dataDir)
	const files = createFiles({home, dataDir})
	const machines = createMachines({dataDir, files, ...machineOptions})
	const storage = createStorage({dataDir, home, files, ...storageOptions})
	const updater = createUpdater({appDir: fileURLToPath(new URL('..', import.meta.url)), dataDir, currentVersion: OMARCHYD_VERSION, ...updaterOptions})
	// One certificate context for the app gateways and the Security settings.
	const tlsDir = appOptions.tlsDir ?? join(dataDir, 'tls')
	const secure = appOptions.secure ?? tlsContext({dir: tlsDir, lazy: true})
	const apps = createApps({dataDir, home, webPort, firewall: storage.firewall, ...appOptions, tlsDir, secure})
	// Security settings kept by omarchyd itself (the https setting lives with the certificates,
	// where the web server reads it too).
	const securityFile = join(dataDir, 'security.json')
	const security = {lockAfterRemote: true, ...JSON.parse((await readFile(securityFile, 'utf8').catch(() => null)) ?? '{}')}
	// Console tickets: single-use, 30 seconds, for the WebSocket bridge (same contract as before).
	const tickets = new Map()
	const release = await system.osRelease()
	const settings = {hostname: os.hostname()}

	// Apps and machines in the usage breakdown; "System" is everything else.
	async function withUsage(totalP, kind) {
		const total = await totalP
		let apps = []
		let vms = []
		try {
			apps = apps_usage()
			vms = machines.usage?.() ?? []
		} catch {
			/* breakdown unavailable: totals still right */
		}
		const threads = os.cpus().length || 1
		const value = (u) => (kind === 'cpu' ? Math.round(Math.min(100, (100 * u.cpuShare) / threads) * 10) / 10 : Math.round(u.memBytes))
		const appItems = apps.map((u) => ({id: u.id, used: value(u)})).filter((u) => u.used > 0)
		const vmItems = vms.map((u) => ({id: u.id, name: u.name, used: value(u)})).filter((u) => u.used > 0)
		const counted = [...appItems, ...vmItems].reduce((t, u) => t + u.used, 0)
		return {...total, apps: appItems, machines: vmItems, system: Math.max(0, total.totalUsed - counted)}
	}
	const apps_usage = () => apps.usage?.() ?? []

	const ownerOnly = (auth, what = 'change the desktop’s theme') => {
		if (accounts.getUser(auth.userId)?.role === 'member') throw new RpcError('FORBIDDEN', `Only the server’s owner can ${what}`)
	}
	const themeCall = async (fn) => {
		try {
			return await fn()
		} catch (e) {
			throw new RpcError(e.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED', e.message)
		}
	}
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
		// The same for someone already signed in (no second password or 2FA check).
		'user.browserSession': {
			kind: 'mutation',
			run: async (_input, {res, auth}) => {
				const {bearer, cookie, userId} = await accounts.browserFor(auth)
				await apps.ready
				res.setHeader('set-cookie', [`OMARCHY_BROWSER_SESSION=${cookie}; Path=/; HttpOnly; SameSite=Strict`, apps.sessionCookie(apps.issueSession(userId))])
				return bearer
			},
		},
		'user.renewToken': {kind: 'mutation', run: async (_i, {auth}) => (auth.kind === 'browser' && (await accounts.renewBrowser(auth.bearer)), 'renewed')},
		'user.logout': {kind: 'mutation', run: async (_i, {auth}) => (await accounts.logout(auth), true)},
		// ---- the Omarchy desktop's themes (Settings → Appearance → Omarchy) ---------------------------
		'omarchy.themes': {kind: 'query', run: () => omarchyTheme.themes()},
		'omarchy.setTheme': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.setTheme(String(input?.slug ?? ''))))},
		'omarchy.installTheme': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.installTheme(String(input?.slug ?? ''))))},
		'omarchy.removeTheme': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.removeTheme(String(input?.slug ?? ''))))},
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
		'system.cpuUsage': {kind: 'query', run: () => withUsage(system.cpuUsage(), 'cpu')},
		'system.memoryUsage': {kind: 'query', run: () => withUsage(system.memoryUsage(), 'memory')},
		'system.diskUsage': {kind: 'query', run: () => system.diskUsage(home, {dataDir})},
		'system.cpuTemperature': {kind: 'query', run: () => system.cpuTemperature()},
		'system.getHostname': {kind: 'query', run: () => settings.hostname},
		'system.getIpAddresses': {kind: 'query', run: () => system.ipAddresses()},
		'system.device': {kind: 'query', run: async () => ({device: await system.deviceName(), os: release.pretty})},

		// ---- Settings: power, logs, device name, two-factor, sessions, reset ----------------------
		'system.restart': {kind: 'mutation', run: (_i, {auth}) => (ownerOnly(auth, 'restart the server'), power('reboot'))},
		'system.shutdown': {kind: 'mutation', run: (_i, {auth}) => (ownerOnly(auth, 'shut down the server'), power('poweroff'))},
		'system.logs': {
			kind: 'query',
			run: async (input, {auth}) => {
				ownerOnly(auth, 'read the logs')
				const lines = Math.max(50, Math.min(5000, Number(input?.lines) || 1000))
				const args =
					input?.type === 'system'
						? ['-n', String(lines), '--no-pager', '-o', 'short-iso']
						: ['--user', '-u', 'omarchyd.service', '-u', 'omarchy-server-web.service', '-u', 'omarchy-server-desktop.service', '-n', String(lines), '--no-pager', '-o', 'short-iso']
				const r = await sh('journalctl', args, 20_000)
				const text = r.out || r.err || 'No log lines.'
				const max = Math.max(10_000, Math.min(1_000_000, Number(input?.maxOutputBytes) || 400_000))
				return text.length > max ? text.slice(-max) : text
			},
		},
		'system.setHostname': {
			kind: 'mutation',
			run: async (input, {auth}) => {
				ownerOnly(auth, 'change the device name')
				const name = String(input?.hostname ?? '').trim().toLowerCase()
				await storage.helper('hostname', [name])
				settings.hostname = name
				return true
			},
		},
		'user.is2faEnabled': {kind: 'query', run: (_i, {auth}) => accounts.is2faEnabled(auth.userId)},
		'user.generateTotpUri': {kind: 'query', run: (_i, {auth}) => accounts.totpUri(auth.userId)},
		'user.enable2fa': {kind: 'mutation', run: async (input, {auth}) => (await accounts.enable2fa(auth.userId, input ?? {}), true)},
		'user.disable2fa': {kind: 'mutation', run: async (input, {auth}) => (await accounts.disable2fa(auth.userId, input ?? {}), true)},
		// A fresh app pass for this person, ending the ones their other devices hold.
		'user.revokeAppPasses': {kind: 'mutation', run: async (_i, {auth}) => apps.sessionCookie(await apps.revokePasses(auth.userId))},
		'system.factoryReset': {
			kind: 'mutation',
			run: async (input, {auth}) => {
				ownerOnly(auth, 'reset Omarchy Server')
				await accounts.confirmPassword(auth.userId, input?.password)
				// Answer first; the reset carries on by itself.
				setTimeout(async () => {
					await apps.uninstallAll().catch((e) => console.error('[omarchyd] reset apps', e.message))
					await machines.uninstallAll().catch((e) => console.error('[omarchyd] reset machines', e.message))
					await accounts.reset()
					console.log('[omarchyd] factory reset done')
				}, 500)
				return true
			},
		},
		'wifi.supported': {kind: 'query', run: () => wifi.supported()},
		'wifi.connect': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth, 'change Wi-Fi'), wifi.connect(input))},
		'wifi.disconnect': {kind: 'mutation', run: (_i, {auth}) => (ownerOnly(auth, 'change Wi-Fi'), wifi.disconnect())},

		// ---- not built yet: answer empty so the web app shows empty states, not errors ----------
		// The bell: an update waiting (until it's installed or you dismiss that version).
		'system.desktopShare': {
			kind: 'mutation',
			run: async () => {
				// Right after a sign-in the desktop takes a few seconds to come up.
				for (let i = 0; ; i++) {
					try {
						return await desktopShare()
					} catch (e) {
						if (i >= 5 || !/DESKTOP_SIGNED_OUT/.test(e.message) || !recentSignIn()) throw e
						await new Promise((r) => setTimeout(r, 2000))
					}
				}
			},
		},
		// The system drive got bigger: grow the partition, encryption and filesystem into the space
		// (helper verb grow-system). The disk password, if any, only passes through to cryptsetup.
		'storage.growSystem': {
			kind: 'mutation',
			run: async (input, {auth}) => {
				ownerOnly(auth, 'change the system drive')
				const pw = typeof input?.password === 'string' ? input.password : ''
				if (pw.length > 512 || /[\r\n]/.test(pw)) throw new RpcError('BAD_REQUEST', 'Bad password')
				try {
					return JSON.parse(await storage.helper('grow-system', [], pw ? `${pw}\n` : ''))
				} catch (e) {
					if (/Unknown action/.test(e.message)) throw new RpcError('PRECONDITION_FAILED', 'Run the Omarchy Server installer again once to add this (its storage helper changed).')
					// "NEEDS_PASSWORD: …" tells the web app to ask for the disk password.
					throw new RpcError('PRECONDITION_FAILED', e.message)
				} finally {
					system.forgetDrive()
				}
			},
		},
		'system.security': {
			kind: 'query',
			run: async () => ({
				...(await authorityInfo(tlsDir)),
				alwaysHttps: (await readPolicy(tlsDir)).alwaysHttps,
				lockAfterRemote: security.lockAfterRemote !== false,
			}),
		},
		'system.setSecurity': {
			kind: 'mutation',
			run: async (input, {auth}) => {
				ownerOnly(auth, 'change security settings')
				if (typeof input?.alwaysHttps === 'boolean') {
					await writePolicy(tlsDir, {alwaysHttps: input.alwaysHttps})
					await secure.refresh?.()
				}
				if (typeof input?.lockAfterRemote === 'boolean') {
					security.lockAfterRemote = input.lockAfterRemote
					await writeFile(securityFile, JSON.stringify(security), {mode: 0o600})
				}
				return true
			},
		},
		// A new, restricted certificate authority (see tls.mjs). Devices need the new certificate.
		'system.replaceCertificate': {
			kind: 'mutation',
			run: async (_i, {auth}) => {
				ownerOnly(auth, 'replace the certificate')
				await rotateAuthority({dir: tlsDir})
				await secure.refresh?.()
				return authorityInfo(tlsDir)
			},
		},
		// Sign the owner in to the Omarchy desktop when it's at its sign-in screen or locked out.
		'system.desktopSignIn': {
			kind: 'mutation',
			run: async (input, {auth}) => {
				ownerOnly(auth)
				await accounts.confirmPassword(auth.userId, input?.password)
				const r = await storage.helper('desktop-sign-in')
				signedInAt = Date.now()
				remoteSignIn = true
				return {result: r}
			},
		},
		'notifications.get': {
			kind: 'query',
			run: async () => {
				const v = updater.updateWaiting()
				const dismissed = await readFile(join(dataDir, 'dismissed-update'), 'utf8').catch(() => '')
				return v && dismissed.trim() !== v ? ['update-available'] : []
			},
		},
		'notifications.clear': {
			kind: 'mutation',
			run: async (input) => {
				const v = updater.updateWaiting()
				if (input === 'update-available' && v) await writeFile(join(dataDir, 'dismissed-update'), v, {mode: 0o600})
				return true
			},
		},
		'wifi.connected': {kind: 'query', run: () => wifi.connected()},
		'wifi.networks': {kind: 'query', run: () => wifi.networks()},

		...files.procedures,
		...storage.procedures,
		...machines.procedures,
		...apps.procedures,
		...updater.procedures,
		'apps.getTorEnabled': {kind: 'query', run: () => false},
	}

	const omarchyTheme = createOmarchyTheme({home})
	let signedInAt = 0
	// After a sign-in from the web, lock the desktop again once nobody is viewing it (Settings →
	// Security), so the screen isn't left signed in at the server itself. A short wait lets a page
	// reload or a reconnect keep the session.
	let remoteSignIn = false
	let desktopViewers = 0
	let lockTimer = null
	const lockGraceMs = machineOptions.lockGraceMs ?? 60_000
	const viewerJoined = () => {
		desktopViewers++
		clearTimeout(lockTimer)
	}
	const viewerLeft = () => {
		desktopViewers = Math.max(0, desktopViewers - 1)
		if (desktopViewers || !remoteSignIn || security.lockAfterRemote === false) return
		clearTimeout(lockTimer)
		lockTimer = setTimeout(() => {
			if (desktopViewers) return
			remoteSignIn = false
			lockDesktop().catch((e) => console.error('[omarchyd] couldn’t lock the desktop:', e.message))
		}, lockGraceMs)
		lockTimer.unref?.()
	}
	async function lockDesktop() {
		if (machineOptions.lockDesktop) return machineOptions.lockDesktop()
		// The owner's own graphical session on this machine: logind tells Omarchy's lock screen.
		const me = os.userInfo().username
		const list = await sh('loginctl', ['list-sessions', '--no-legend'])
		for (const line of list.out.split('\n')) {
			const [id, , user] = line.trim().split(/\s+/)
			if (!id || user !== me) continue
			const type = await sh('loginctl', ['show-session', id, '-p', 'Type', '--value'])
			if (!/wayland|x11/.test(type.out)) continue
			if ((await sh('loginctl', ['lock-session', id])).ok) return
		}
		// Fallback: start the lock screen directly in the desktop.
		const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`
		const socket = (await readdir(runtime).catch(() => [])).find((f) => /^wayland-\d+$/.test(f))
		if (!socket) return
		const r = await sh('systemd-run', ['--user', '--collect', `--setenv=WAYLAND_DISPLAY=${socket}`, `--setenv=XDG_RUNTIME_DIR=${runtime}`, 'hyprlock'])
		if (!r.ok) throw new Error(r.err || 'hyprlock didn’t start')
	}
	const recentSignIn = () => Date.now() - signedInAt < 60_000

	// The Omarchy desktop's screen, shared by wayvnc on 127.0.0.1 only. Start it when it isn't
	// running (the session may have started before it was installed), or explain why it can't run.
	const reachable = (port, ms = 800) =>
		new Promise((resolve) => {
			const c = net.connect({host: '127.0.0.1', port})
			const done = (ok) => (c.destroy(), resolve(ok))
			c.setTimeout(ms, () => done(false))
			c.once('connect', () => done(true))
			c.once('error', () => done(false))
		})
	const sh = async (cmd, args, timeout = 10_000) => {
		const {execFile} = await import('node:child_process')
		return new Promise((resolve) => execFile(cmd, args, {timeout}, (err, out, errOut) => resolve({ok: !err, out: String(out ?? ''), err: String(errOut ?? err?.message ?? '')})))
	}
	// The desktop's screen is shared on a private socket in your runtime folder (only you can open
	// it; containers, even on the host network, can't). Older installs shared it on 127.0.0.1:5900,
	// which any program on the server could reach: still used until the share is moved (below).
	const socketUp = (path, ms = 800) =>
		new Promise((resolve) => {
			const c = net.connect({path})
			const done = (ok) => (c.destroy(), resolve(ok))
			c.setTimeout(ms, () => done(false))
			c.once('connect', () => done(true))
			c.once('error', () => done(false))
		})
	// Where the console connects: the private socket when it exists, else the old port.
	async function desktopTarget() {
		if ((await stat(desktopVncSocket).catch(() => null))?.isSocket()) return {path: desktopVncSocket}
		return {host: '127.0.0.1', port: desktopVncPort}
	}
	const desktopUp = async () => (await socketUp(desktopVncSocket)) || (await reachable(desktopVncPort))
	const waitFor = async (_port, seconds) => {
		for (let i = 0; i < seconds * 4; i++) {
			if (await desktopUp()) return true
			await new Promise((r) => setTimeout(r, 250))
		}
		return false
	}
	// Move an older install's desktop share from 127.0.0.1:5900 to the private socket, so updating is
	// enough (no need to run the installer again).
	const DESKTOP_UNIT = `[Unit]
Description=Omarchy Server: share this Omarchy desktop with the web app (private socket)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStartPre=/usr/bin/mkdir -p -m 0700 %t/omarchy-server
ExecStartPre=/usr/bin/rm -f %t/omarchy-server/desktop-vnc.sock
ExecStart=/usr/bin/wayvnc --max-fps=30 --unix-socket %t/omarchy-server/desktop-vnc.sock
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`
	async function moveDesktopShare() {
		if (machineOptions.run) return
		const unit = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user/omarchy-server-desktop.service')
		const text = await readFile(unit, 'utf8').catch(() => null)
		if (text === null || text.includes('--unix-socket')) return
		await writeFile(unit, DESKTOP_UNIT)
		await sh('systemctl', ['--user', 'daemon-reload'])
		if ((await sh('systemctl', ['--user', 'is-active', 'omarchy-server-desktop.service'])).ok) await sh('systemctl', ['--user', 'restart', 'omarchy-server-desktop.service'])
		// A one-off share started by desktopShare() on the old port.
		await sh('systemctl', ['--user', 'stop', 'omarchy-server-desktop-now.service'])
	}
	moveDesktopShare().catch((e) => console.error('[omarchyd] desktop share', e.message))
	// Restart / shut down: through logind as yourself when allowed, otherwise through the helper.
	async function power(what) {
		if (machineOptions.run) return true // dev/test stand-in
		setTimeout(async () => {
			const r = await sh('systemctl', ['--no-block', what], 10_000)
			if (!r.ok) await storage.helper('power', [what]).catch((e) => console.error('[omarchyd] power', e.message))
		}, 1500)
		return true
	}

	// Wi-Fi through iwd (what Omarchy uses; its Wi-Fi menu is impala on iwctl).
	const wifi = {
		async iface() {
			const nets = await readdir('/sys/class/net').catch(() => [])
			for (const n of nets) if (await readdir(`/sys/class/net/${n}/wireless`).then(() => true, () => false)) return n
			return null
		},
		async supported() {
			return !!(await this.iface()) && (await sh('iwctl', ['--version'], 5000)).ok
		},
		clean: (t) => t.replace(/\x1b\[[0-9;]*m/g, ''),
		async connected() {
			const i = await this.iface()
			if (!i) return {status: 'disconnected'}
			const r = await sh('iwctl', ['station', i, 'show'], 8000)
			const ssid = /Connected network\s+(.+?)\s*$/m.exec(this.clean(r.out))?.[1]
			return ssid ? {status: 'connected', ssid} : {status: 'disconnected'}
		},
		async networks() {
			const i = await this.iface()
			if (!i) return []
			await sh('iwctl', ['station', i, 'scan'], 8000)
			const r = await sh('iwctl', ['station', i, 'get-networks'], 8000)
			const out = []
			for (const raw of this.clean(r.out).split('\n')) {
				const m = /^\s*(>?)\s*(.+?)\s{2,}(psk|open|8021x|wep)\s+(\*+)\s*$/.exec(raw)
				if (m) out.push({ssid: m[2].trim(), signal: Math.round((m[4].length / 4) * 100), authenticated: m[3] !== 'open', active: m[1] === '>'})
			}
			return out
		},
		async connect(input) {
			const i = await this.iface()
			const ssid = String(input?.ssid ?? '')
			if (!i) throw new RpcError('PRECONDITION_FAILED', 'This server has no Wi-Fi')
			if (!ssid || ssid.length > 64 || /[\x00-\x1f]/.test(ssid)) throw new RpcError('BAD_REQUEST', 'Pick a network')
			const pw = typeof input?.password === 'string' ? input.password : null
			const r = await sh('iwctl', [...(pw ? ['--passphrase', pw] : []), 'station', i, 'connect', ssid], 30_000)
			if (!r.ok) throw new RpcError('BAD_GATEWAY', /passphrase|authentication|operation failed/i.test(r.err + r.out) ? 'Couldn’t connect. Check the password.' : `Couldn’t connect to ${ssid}`)
			return true
		},
		async disconnect() {
			const i = await this.iface()
			if (i) await sh('iwctl', ['station', i, 'disconnect'], 10_000)
			return true
		},
	}

	async function desktopShare() {
		if (machineOptions.run) return true // the dev/test stand-in has no desktop
		if (await desktopUp()) return true
		if (!(await readFile('/usr/bin/wayvnc').then(() => true, () => false)))
			throw new RpcError('PRECONDITION_FAILED', 'Screen sharing (wayvnc) isn’t installed. Run the Omarchy Server installer again to add it.')
		await sh('systemctl', ['--user', 'reset-failed', 'omarchy-server-desktop.service'])
		await sh('systemctl', ['--user', 'start', 'omarchy-server-desktop.service'])
		if (await waitFor(desktopVncPort, 5)) return true
		// The service may lack the desktop's Wayland details (a session started without passing
		// them to systemd): run wayvnc once with them, found from the running Hyprland.
		const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`
		const socket = (await readdir(runtime).catch(() => [])).find((f) => /^wayland-\d+$/.test(f))
		const hypr = (await readdir(join(runtime, 'hypr')).catch(() => []))[0]
		if (!socket) throw new RpcError('PRECONDITION_FAILED', 'DESKTOP_SIGNED_OUT: The Omarchy desktop is at its sign-in screen, so there’s no screen to show yet.')
		await mkdir(dirname(desktopVncSocket), {recursive: true, mode: 0o700})
		await rm(desktopVncSocket, {force: true})
		await sh('systemd-run', ['--user', '--collect', '--unit=omarchy-server-desktop-now', `--setenv=WAYLAND_DISPLAY=${socket}`, `--setenv=XDG_RUNTIME_DIR=${runtime}`, ...(hypr ? [`--setenv=HYPRLAND_INSTANCE_SIGNATURE=${hypr}`] : []), '/usr/bin/wayvnc', '--max-fps=30', '--unix-socket', desktopVncSocket])
		if (await waitFor(desktopVncPort, 5)) return true
		const log = await sh('journalctl', ['--user', '-u', 'omarchy-server-desktop.service', '-u', 'omarchy-server-desktop-now.service', '-n', '3', '--no-pager', '-o', 'cat'])
		const last = log.out.trim().split('\n').filter(Boolean).pop()
		throw new RpcError('BAD_GATEWAY', `The desktop’s screen sharing (wayvnc) didn’t start${last ? `: ${last}` : ''}. Check it with: omarchy-server logs`)
	}
	// The web app's wallpaper is the current Omarchy theme background.
	async function wallpaper(res) {
		const real = await omarchyTheme.currentBackground()
		const type = real && {'.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}[extname(real).toLowerCase()]
		const data = type ? await readFile(real).catch(() => null) : null
		if (!data) {
			res.writeHead(404)
			return res.end()
		}
		res.writeHead(200, {'content-type': type, 'content-length': data.length, 'cache-control': 'no-cache'})
		res.end(data)
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
			const preview = /^\/omarchy\/preview\/([a-z0-9_][a-z0-9._+-]{0,80})$/.exec(url.pathname)
			if (preview && req.method === 'GET') return await omarchyTheme.servePreview(preview[1], res)
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
			const target = machineId === 'desktop' ? await desktopTarget() : await machines.vncSocket(machineId).then((path) => ({path}), () => null)
			if (!target) return refuse('409 Conflict')
			const vnc = net.connect(target)
			vnc.once('error', () => refuse('502 Bad Gateway'))
			vnc.once('connect', () => {
				vnc.removeAllListeners('error')
				wss.handleUpgrade(req, socket, head, (ws) => {
					if (machineId === 'desktop') {
						viewerJoined()
						ws.once('close', viewerLeft)
					}
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
	// Remove a one-time desktop sign-in an interrupted attempt may have left.
	if (!machineOptions.run) storage.helper('desktop-sign-in-cleanup').catch(() => {})
	// Pools set up by earlier versions: mount them nosuid,nodev too. A helper from before 0.9.4
	// answers "Unknown action" until install.sh is run again; that's fine.
	if (!machineOptions.run)
		storage
			.helper('harden-pools')
			.then((r) => r && r !== '{"fstab":0,"zfs":0}' && console.log('[omarchyd] hardened pool mounts', r))
			.catch(() => {})

	// Once: put the Omarchy Server icon in the Omarchy top bar (servers installed before the
	// icon supported Omarchy's own bar never got it). `omarchy-server widget off` removes it for good.
	const widgetMark = join(dataDir, '.top-bar-widget-added')
	const widgetBin = join(home, '.local', 'bin', 'omarchy-server')
	setTimeout(async () => {
		if (!appOptions.run && !(await readFile(widgetMark).then(() => true, () => false)) && (await readFile(widgetBin).then(() => true, () => false))) {
			const {execFile} = await import('node:child_process')
			execFile(widgetBin, ['widget', 'on'], {timeout: 30_000}, (err) => !err && writeFile(widgetMark, new Date().toISOString()).catch(() => {}))
		}
	}, 20_000).unref?.()

	return {url: `http://${host}:${server.address().port}`, accounts, close: () => (apps.close(), updater.stop(), new Promise((r) => server.close(r)))}
}
