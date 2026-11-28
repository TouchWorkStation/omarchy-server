// omarchyd: the My Own Data Center backend. It listens on localhost only; the Touch web server in front
// of it is the one thing that faces the network. Runs as the owner's own user, not root.
import {execFile} from 'node:child_process'
import {lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import http from 'node:http'
import {fileURLToPath} from 'node:url'
import net from 'node:net'
import os from 'node:os'
import {dirname, extname, join} from 'node:path'

import {openAccounts} from './accounts.mjs'
import {writeAtomic} from './atomic.mjs'
import {createAssistant} from './assistant.mjs'
import {createBackups} from './backups.mjs'
import {createUnraid} from './unraid.mjs'
import {APP_COOKIE, createApps} from './apps.mjs'
import {contentDisposition, createFiles} from './files.mjs'
import {createFileTransfer} from './file-transfer.mjs'
import {installTargetId} from './install-target.mjs'
import {fileUrl, localGitDir} from './local-source.mjs'
import {createMachines} from './machines.mjs'
import {createContainers} from './containers.mjs'
import {createOmarchyTheme} from './omarchy-theme.mjs'
import {createOmarchyPlugins} from './omarchy-plugins.mjs'
import {createClips} from './clips.mjs'
import {createToasts} from './toasts.mjs'
import {createTransfers} from './transfers.mjs'
import {closeReason, createConnector} from './connector.mjs'
import {createStorage} from './storage.mjs'
import {createUsb, listHostUsb} from './usb.mjs'
import {createTerminalSessions, createTmux} from './terminal.mjs'
import {createUpdater} from './updater.mjs'
import {createSystemApps} from './system-apps.mjs'
import {createTailscale} from './tailscale.mjs'
import {createConnect} from './connect.mjs'
import {createOidc} from './oidc.mjs'
import {createHyprland} from './hyprland.mjs'
import {authorityInfo, readPolicy, rotateAuthority, tlsContext, writePolicy} from './tls.mjs'
import {RpcError, handleRpc, sendError, sendJson} from './rpc.mjs'
import {createHermes} from './hermes.mjs'
import * as system from './system.mjs'
import {createSampler} from './stats.mjs'
import {createOsInfo} from './os-info.mjs'
import {WebSocketServer} from 'ws'
import {viewerBackpressure} from './backpressure.mjs'

export const OMARCHYD_VERSION = '0.9.108'
// Written by install.sh when the owner turns on unattended boot: the disk then unlocks itself at boot.
export const UNATTENDED_BOOT_CONF = '/etc/mkinitcpio.conf.d/zz-modc-unattended.conf'

export async function startOmarchyd({port = 2021, host = '127.0.0.1', dataDir, tlsDir: sharedTlsDir = null, home = os.homedir(), webPort = 7780, machineOptions = {}, containerOptions = {}, appOptions = {}, storageOptions = {}, updaterOptions = {}, pluginOptions = {}, themeOptions = {}, assistantOptions = {}, usbOptions = {}, backupOptions = {}, unraidOptions = {}, tailscaleOptions = {}, oidcOptions = {}, connectOptions = {}, hyprlandOptions = {}, terminalTmux = process.env.NODE_TEST_CONTEXT ? null : undefined, desktopVncPort = 5900, viewerStallMs = undefined, desktopVncSocket = join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`, 'omarchy-server', 'desktop-vnc.sock')}) {
	const sourceDir = localGitDir('OMARCHY_SERVER_SOURCE', process.env.OMARCHY_SERVER_SOURCE)
	const storeDir = localGitDir('OMARCHY_SERVER_APP_STORE', process.env.OMARCHY_SERVER_APP_STORE)
	const appDir = fileURLToPath(new URL('..', import.meta.url))
	const startedAt = Date.now()
	const revision = await new Promise((resolve) => {
		execFile('git', ['-C', appDir, 'rev-parse', '--short', 'HEAD'], {timeout: 5_000}, (err, stdout) => {
			const sha = String(stdout ?? '').trim()
			resolve(err || !/^[0-9a-f]{7,40}$/i.test(sha) ? undefined : sha)
		})
	})
	const accounts = await openAccounts(dataDir)
	// Security settings kept by omarchyd itself (the https setting lives with the certificates,
	// where the web server reads it too). Only a plain object is settings: a string or array is
	// valid JSON, but spreading it would pollute this object and the next save would overwrite the
	// file. An empty, invalid, or non-object file starts locked and is not rewritten. Any other
	// read error stops startup. The log names the file only, never its path or contents.
	// Read this before apps and machines start: they write state in the background, and an
	// unreadable file must fail before those writes are in flight.
	const securityFile = join(dataDir, 'security.json')
	let saved = {}
	let badSecurity = false
	try {
		const parsed = JSON.parse(await readFile(securityFile, 'utf8'))
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed
		else badSecurity = true
	} catch (e) {
		if (e instanceof SyntaxError) badSecurity = true
		else if (e.code !== 'ENOENT') throw e
	}
	if (badSecurity) console.error('[omarchyd] security.json is empty or invalid and was left unchanged')
	let security = {lockAfterRemote: true, ...saved}
	const files = createFiles({home, dataDir})
	const defaultStores = storeDir ? [{url: fileUrl(storeDir)}] : undefined
	const catalogUrl = storeDir ? fileUrl(join(storeDir, 'machines', 'catalog.json')) : undefined
	let connector
	// Filled in once usb exists: removing an app or machine takes its attached sticks' udev rules out.
	let usbReleased = async () => {}
	const machines = createMachines({
		dataDir,
		files,
		usbReleased: (devices) => usbReleased(devices),
		...(catalogUrl ? {catalogUrl} : {}),
		isOwner: (ctx) => accounts.getUser(ctx?.auth?.userId)?.role !== 'member',
		connector: {
			pair: (input) => connector.procedures['swarm.pair'].run(input),
			list: () => connector.procedures['swarm.list'].run(),
			call: (id, name, args, timeout) => connector.call(id, name, args, timeout),
			progress: (id) => connector.progress(id),
		},
		...machineOptions,
	})
	// Containers (LXC through per-user Incus): list/status for everyone; Incus mutations owner-only.
	// Connector install uses the local swarm (bound below once createConnector runs).
	const containers = createContainers({
		reservedPorts: [port, webPort],
		backupsDir: join(dataDir, 'container-backups'),
		files,
		connector: {
			pair: (input) => connector.procedures['swarm.pair'].run(input),
			list: () => connector.procedures['swarm.list'].run(),
			caCertificate: () => connector.caCertificate(),
		},
		...containerOptions,
	})
	const storage = createStorage({dataDir, home, files, ...storageOptions})
	const updater = createUpdater({appDir, dataDir, currentVersion: OMARCHYD_VERSION, webPort, ...(sourceDir ? {sourceDir} : {}), ...(storeDir ? {appStoreDir: storeDir} : {}), ...updaterOptions})
	// One certificate context for the app gateways and the Security settings. On a server this is
	// the folder the web server uses too (omarchyd/cli.mjs passes it), so apps are served with the
	// certificate your devices trust and the Security settings reach both. Before 0.9.13 omarchyd kept
	// its own in <data>/tls; a setting made there is carried over once.
	const tlsDir = appOptions.tlsDir ?? sharedTlsDir ?? join(dataDir, 'tls')
	if (tlsDir !== join(dataDir, 'tls')) await carryOverTls(join(dataDir, 'tls'), tlsDir)
	const secure = appOptions.secure ?? tlsContext({dir: tlsDir, lazy: true})
	// Apps that are part of the server itself (Tailscale), installed through the root helper.
	const systemApps = appOptions.systemApps !== undefined ? appOptions.systemApps || null : createSystemApps({helper: storage.helper})
	const oidc = createOidc({dataDir, accounts, ...oidcOptions})
	const tailscale = createTailscale({...tailscaleOptions})
	// The connector is created later. These bindings are filled in once it exists, so an install
	// aimed at another machine is forwarded there instead of running on this server.
	let forwardInstall = async () => {
		throw new RpcError('PRECONDITION_FAILED', 'That computer can’t take this install yet.')
	}
	let remoteApps = async () => []
	const apps = createApps({
		dataDir,
		home,
		webPort,
		firewall: storage.firewall,
		...(defaultStores ? {defaultStores} : {}),
		...appOptions,
		systemApps,
		tlsDir,
		secure,
		usbReleased: (devices) => usbReleased(devices),
		forwardInstall: (...args) => forwardInstall(...args),
		remoteApps: () => remoteApps(),
		oidc,
		getTailscaleStatus: () => tailscale.procedures['tailscale.status'].run().catch(() => null),
	})
	// Backups need apps: to pause them while their files are saved, and to know where those files are.
	// …and the local swarm's connector (created further down), for computers that back up here.
	const backups = createBackups({dataDir, home, files, apps, swarm: {agents: () => connector.backup.agents(), call: (...a) => connector.backup.call(...a), progress: (id) => connector.backup.progress(id)}, ...backupOptions})
	// Move from Unraid: its shares, containers and VMs, brought over SSH.
	const unraid = createUnraid({dataDir, files, apps, machines, storage, ...unraidOptions})
	// MODC Connect: this installation paired with the owner's myowndatacenter.com account. Only check-ins
	// for now; it opens nothing. Tests never reach the website unless they pass their own fetch.
	const connect = createConnect({dataDir, accounts, version: OMARCHYD_VERSION, ...(process.env.NODE_TEST_CONTEXT ? {autoStart: false, fetchImpl: async () => Promise.reject(Object.assign(new Error('offline in tests'), {code: 'ENOTFOUND'})), tunnelOptions: {unitDir: join(dataDir, 'test-units'), systemPaths: [], sh: async () => ({ok: false, code: 1, out: '', err: ''})}, ssoOptions: {post: async () => Promise.reject(new Error('offline in tests'))}} : {}), ...connectOptions})
	const usb = createUsb({
		enumerate: () => listHostUsb(usbOptions),
		guests: {
			bindings: async () => [...(await machines.usbBindings()), ...(await apps.usbBindings())],
			bind: (guest, rec) => (guest.kind === 'machine' ? machines.bindUsb(guest.id, rec) : apps.bindUsb(guest.id, rec)),
			unbind: (guest, deviceId) => (guest.kind === 'machine' ? machines.unbindUsb(guest.id, deviceId) : apps.unbindUsb(guest.id, deviceId)),
			liveAttach: (guest, rec) => (guest.kind === 'machine' ? machines.attachHostdev(guest.id, rec) : false),
			liveDetach: (guest, rec) => (guest.kind === 'machine' ? machines.detachHostdev(guest.id, rec) : false),
		},
		helper: (verb, args) => storage.helper(verb, args),
	})
	usbReleased = usb.release
	// Console tickets: single-use, 30 seconds, for the WebSocket bridge (same contract as before).
	const tickets = new Map()
	const hyprSocketsBySession = new Map() // sessionId -> Set<WebSocket>
	const hyprSseBySession = new Map() // sessionId -> Set<() => void>
	const allHyprSse = new Set() // Set<() => void>
	let factoryResetInProgress = false
	function revokeHyprSocket(ws, reason = 'Session ended') {
		try {
			if (typeof ws.__omarchyRevoke === 'function') {
				ws.__omarchyRevoke(1008, reason)
				return
			}
		} catch {}
		try {
			ws.close(1008, reason)
		} catch {}
	}
	function revokeSessionStreams(sessionId) {
		if (!sessionId) return
		for (const [tk, v] of tickets) {
			if (v.sessionId === sessionId) tickets.delete(tk)
		}
		const set = hyprSocketsBySession.get(sessionId)
		if (set) {
			hyprSocketsBySession.delete(sessionId)
			for (const ws of set) revokeHyprSocket(ws, 'Session ended')
		}
		const sseSet = hyprSseBySession.get(sessionId)
		if (sseSet) {
			hyprSseBySession.delete(sessionId)
			for (const stop of [...sseSet]) {
				try {
					stop()
				} catch {}
			}
		}
	}
	function revokeAllHyprStreams() {
		for (const [tk, v] of tickets) {
			if (v.target === 'hyprland') tickets.delete(tk)
		}
		for (const set of hyprSocketsBySession.values()) {
			for (const ws of set) revokeHyprSocket(ws, 'Session ended')
		}
		hyprSocketsBySession.clear()
		for (const stop of [...allHyprSse]) {
			try {
				stop()
			} catch {}
		}
		allHyprSse.clear()
		hyprSseBySession.clear()
	}
	const release = await system.osRelease()
	const osInfo = createOsInfo({release})
	const settings = {hostname: os.hostname()}

	// Live gauges: hardware is sampled on its own interval while a screen is reading.
	// The timer starts on the first read and stops about 15s after the last one,
	// so an idle server is not running nvidia-smi or podman stats.
	const sampler = createSampler({
		read: {
			cpu: () => system.cpuUsage(),
			memory: () => system.memoryUsage(),
			gpu: () => system.gpuUsage(),
			temp: () => system.cpuTemperature(),
			battery: () => system.batteryUsage(),
			disk: () => system.diskUsage(home, {dataDir}),
			uptime: async () => Math.round(os.uptime()),
			breakdown: async () => {
				try {
					apps.refreshUsage?.()
					return {apps: apps.usage?.() ?? [], machines: machines.usage?.() ?? []}
				} catch {
					return {apps: [], machines: []}
				}
			},
		},
	})

	// Assigned after the connector exists. Factory reset closes over this binding.
	let clips
	let toasts
	let transfers
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
		'system.version': {kind: 'query', public: true, run: () => ({version: OMARCHYD_VERSION, name: `MODC ${OMARCHYD_VERSION}`, startedAt, ...(revision ? {revision} : {})})},
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
		'user.logout': {kind: 'mutation', run: async (_i, {auth}) => (revokeSessionStreams(auth.sessionId), await accounts.logout(auth), true)},
		// ---- the Omarchy desktop's themes (Settings → Appearance → Omarchy) ---------------------------
		'omarchy.themes': {kind: 'query', run: () => omarchyTheme.themes()},
		'omarchy.backgrounds': {kind: 'query', run: (input) => omarchyTheme.backgrounds(input ?? {})},
		'omarchy.setTheme': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.setTheme(String(input?.slug ?? ''))))},
		'omarchy.setBackground': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.setBackground(String(input?.id ?? ''), input?.theme)))},
		'omarchy.installTheme': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.installTheme(String(input?.slug ?? ''))))},
		'omarchy.removeTheme': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth), themeCall(() => omarchyTheme.removeTheme(String(input?.slug ?? ''))))},
		// Verified plugins from the Omarchy plugin registry (see omarchy-plugins.mjs).
		'omarchy.plugins': {kind: 'query', run: (input) => themeCall(() => omarchyPlugins.list(input ?? {}))},
		// Local swarm (connector.mjs): owner only.
		...Object.fromEntries(
			['swarm.list', 'swarm.history', 'swarm.alerts', 'swarm.wake', 'swarm.pair', 'swarm.reauthorize', 'swarm.updateConnector', 'swarm.updateAllConnectors', 'swarm.remove', 'swarm.rename', 'swarm.setAbilities', 'swarm.action', 'swarm.desktopCheck', 'swarm.storage.status', 'swarm.vms.status', 'swarm.storage.disks', 'swarm.storage.pools', 'swarm.storage.importable', 'swarm.storage.unmount', 'swarm.storage.mount', 'swarm.storage.format', 'swarm.storage.createPool', 'swarm.storage.addToPool', 'swarm.storage.importPool', 'swarm.storage.forgetPool', 'swarm.storage.scrub', 'swarm.storage.setSleep', 'swarm.services.list', 'swarm.services.logs', 'swarm.services.control', 'swarm.files.list', 'swarm.files.recents', 'swarm.files.mkdir', 'swarm.files.rename', 'swarm.files.trash', 'swarm.files.copyToServer', 'swarm.files.copyFromServer'].map((name) => [
				name,
				{kind: ['swarm.list', 'swarm.history', 'swarm.alerts', 'swarm.desktopCheck', 'swarm.storage.status', 'swarm.vms.status', 'swarm.storage.disks', 'swarm.storage.pools', 'swarm.storage.importable', 'swarm.services.list', 'swarm.services.logs', 'swarm.files.list', 'swarm.files.recents'].includes(name) ? 'query' : 'mutation', run: (input, {auth}) => (ownerOnly(auth, 'manage the local swarm'), connector.procedures[name].run(input))},
			]),
		),
		'omarchy.installPlugin': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth, 'install Omarchy plugins'), themeCall(() => omarchyPlugins.install(input)))},
		'omarchy.removePlugin': {kind: 'mutation', run: (input, {auth}) => (ownerOnly(auth, 'remove Omarchy plugins'), themeCall(() => omarchyPlugins.remove(input)))},
		'user.get': {kind: 'query', run: (_i, {auth}) => ({...accounts.getUser(auth.userId), wallpaper: {id: '1'}, sambaUsername: os.userInfo().username})},
		'user.set': {kind: 'mutation', run: async (input, {auth}) => (await accounts.updateUser(auth.userId, input), true)},
		'user.changePassword': {kind: 'mutation', run: async (input, {auth}) => (await accounts.setPassword(auth.userId, input ?? {}), true)},
		'user.getHttpApiToken': {kind: 'query', run: (_i, {auth}) => accounts.issueUrlToken(auth)},
		'user.createWebSocketTicket': {
			kind: 'mutation',
			run: (input, {auth}) => {
				if (input?.target !== 'machines' && input?.target !== 'terminal' && input?.target !== 'hyprland') throw new RpcError('BAD_REQUEST', 'Unknown target')
				if (input.target === 'hyprland' && factoryResetInProgress) {
					throw new RpcError('CONFLICT', 'Factory reset is in progress')
				}
				const now = Date.now()
				for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t)
				const ticket = randomBytes(24).toString('base64url')
				tickets.set(ticket, {userId: auth.userId, sessionId: auth.sessionId ?? null, role: accounts.getUser(auth.userId)?.role, target: input.target, expires: now + 30_000})
				return ticket
			},
		},

		// ---- system ---------------------------------------------------------------------------
		// Starting after a restart with nobody signed in (headless servers): systemd's "linger".
		'system.bootStart': {
			kind: 'query',
			run: async (_i, {auth}) => {
				ownerOnly(auth)
				const [startsAtBoot, diskLock] = await Promise.all([bootStart.state(), bootStart.diskLock().catch(() => null)])
				return {startsAtBoot, diskLock}
			},
		},
		'system.enableBootStart': {
			kind: 'mutation',
			run: async (_i, {auth}) => {
				ownerOnly(auth)
				if (await bootStart.enable()) return {startsAtBoot: true}
				throw new RpcError('PRECONDITION_FAILED', `This server can’t turn that on by itself here. On the server, run: sudo loginctl enable-linger ${os.userInfo().username}`)
			},
		},
		'system.stats': {kind: 'query', run: () => sampler.get()},
		'system.uptime': {kind: 'query', run: async () => (await sampler.get()).uptime},
		'system.cpuUsage': {kind: 'query', run: async () => (await sampler.get()).cpu},
		'system.memoryUsage': {kind: 'query', run: async () => (await sampler.get()).memory},
		'system.diskUsage': {kind: 'query', run: async () => (await sampler.get()).disk},
		'system.cpuTemperature': {kind: 'query', run: async () => (await sampler.get()).temp},
		'system.gpuUsage': {kind: 'query', run: async () => (await sampler.get()).gpu},
		'system.batteryUsage': {kind: 'query', run: async () => (await sampler.get()).battery},
		'system.getHostname': {kind: 'query', run: () => settings.hostname},
		'system.getIpAddresses': {kind: 'query', run: () => system.ipAddresses()},
		'system.device': {kind: 'query', run: async () => ({device: await system.deviceName(), os: release.pretty})},
		'system.osInfo': {kind: 'query', run: () => osInfo.get()},

		// ---- Settings: power, logs, device name, two-factor, sessions, reset ----------------------
		'system.restart': {kind: 'mutation', run: async (input, {auth}) => (ownerOnly(auth, 'restart the server'), await bootGuard(input, 'restart'), power('reboot'))},
		'system.shutdown': {kind: 'mutation', run: async (input, {auth}) => (ownerOnly(auth, 'shut down the server'), await bootGuard(input, 'shutdown'), power('poweroff'))},
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
		// A fresh app pass for this person, for a device whose pass is getting old (passes last 30 days).
		'user.appPass': {kind: 'mutation', run: async (_i, {auth}) => apps.sessionCookie(apps.issueSession(auth.userId))},
		// A fresh app pass for this person, ending the ones their other devices hold.
		'user.revokeAppPasses': {kind: 'mutation', run: async (_i, {auth}) => apps.sessionCookie(await apps.revokePasses(auth.userId))},
		'system.factoryReset': {
			kind: 'mutation',
			run: async (input, {auth}) => {
				ownerOnly(auth, 'reset this server')
				await accounts.confirmPassword(auth.userId, input?.password)
				if (factoryResetInProgress) {
					throw new RpcError('CONFLICT', 'Factory reset is already in progress')
				}
				factoryResetInProgress = true
				revokeAllHyprStreams()
				// Answer first; the reset carries on by itself. The next owner must not inherit
				// assistant keys and chats, swarm computers, backup secrets or network shares.
				setTimeout(async () => {
					try {
						const appsLeft = await apps.uninstallAll().catch((e) => console.error('[omarchyd] reset apps', e.message))
						const machinesLeft = await machines.uninstallAll().catch((e) => console.error('[omarchyd] reset machines', e.message))
						// undefined is not a count: machines.uninstallAll returns undefined today.
						const appsRemain = typeof appsLeft === 'number' && appsLeft !== 0
						const machinesRemain = typeof machinesLeft === 'number' && machinesLeft !== 0
						if (appsRemain) console.error(`[omarchyd] ${appsLeft} ${appsLeft === 1 ? 'app remains' : 'apps remain'}`)
						if (machinesRemain) console.error(`[omarchyd] ${machinesLeft} ${machinesLeft === 1 ? 'machine remains' : 'machines remain'}`)
						await assistant.keys.reset().catch((e) => console.error('[omarchyd] reset assistant', e.message))
						// The next owner must not inherit this server's myowndatacenter.com device key.
						await connect.reset().catch(() => console.error('[omarchyd] reset MODC Connect'))
						await assistant.conversations.reset().catch((e) => console.error('[omarchyd] reset assistant', e.message))
						// A clip can be a password or a key. Drop every book even when an app or a machine stays.
						await clips?.resetAll().catch((e) => console.error('[omarchyd] reset clips', e.message))
						await toasts?.resetAll().catch((e) => console.error('[omarchyd] reset toasts', e.message))
						await transfers?.resetAll().catch((e) => console.error('[omarchyd] reset transfers', e.message))
						const agents = await connector.procedures['swarm.list'].run().catch((e) => {
							console.error('[omarchyd] reset swarm', e.message)
							return []
						})
						for (const agent of agents) await connector.procedures['swarm.remove'].run({id: agent.id}).catch((e) => console.error('[omarchyd] reset swarm', e.message))
						await backups.clearSettings().catch((e) => console.error('[omarchyd] reset backups', e.message))
						await storage.clearShares().catch((e) => console.error('[omarchyd] reset shares', e.message))
						await oidc.reset().catch((e) => console.error('[omarchyd] reset oidc', e.message))
						let profilesResetOk = true
						await hyprland.resetProfiles().catch((e) => {
							profilesResetOk = false
							console.error('[omarchyd] reset hyprland profiles', e.message)
						})
						revokeAllHyprStreams()
						if (appsRemain || machinesRemain || !profilesResetOk) return
						await accounts.reset()
						revokeAllHyprStreams()
						console.log('[omarchyd] factory reset done')
					} finally {
						factoryResetInProgress = false
					}
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
					if (/Unknown action/.test(e.message)) throw new RpcError('PRECONDITION_FAILED', 'Run the installer again once to add this (its storage helper changed).')
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
					const next = {...security, lockAfterRemote: input.lockAfterRemote}
					await writeAtomic(securityFile, JSON.stringify(next), {mode: 0o600})
					security = next
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
				markRemoteSignIn()
				hyprland.notifyUnlocked?.().catch(() => {})
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
		...Object.fromEntries(
			Object.entries(storage.procedures).map(([name, p]) =>
				['files.shares', 'files.sharePassword', 'files.shareOptions', 'files.addShare', 'files.updateShare', 'files.removeShare', 'files.setSharePassword'].includes(name)
					? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage network shares'), p.run(input))}]
					: ['storage.createPool', 'storage.addToPool', 'storage.importPool', 'storage.forgetPool', 'storage.scrub', 'storage.setSleep', 'storage.format', 'storage.unmount', 'storage.mount'].includes(name)
						? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'change storage'), p.run(input))}]
						: [name, p],
			),
		),
		...Object.fromEntries(
			Object.entries(containers.procedures).map(([name, p]) =>
				name === 'containers.list' || name === 'containers.status'
					? [name, p]
					: [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage containers'), p.run(input))}],
			),
		),
		...Object.fromEntries(
			Object.entries(machines.procedures).map(([name, p]) =>
				name === 'machines.installConnector'
					? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'install a guest connector'), p.run(input))}]
					: name === 'machines.downloadIso' || name === 'machines.isoDownloads'
						? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'download ISOs to this server'), p.run(input))}]
						: [name, p],
			),
		),
		...Object.fromEntries(
			Object.entries(apps.procedures).map(([name, p]) =>
				name === 'appStore.addRepository' || name === 'appStore.removeRepository'
					? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'change app stores'), p.run(input))}]
					: name === 'apps.oidcStatus' || name === 'apps.setOidc'
						? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage single sign-on'), p.run(input))}]
						: name === 'apps.install'
							? [
									name,
									{
										kind: p.kind,
										run: (input, ctx) => {
											// This server’s own install stays as open as it is today. Another machine or OIDC wiring is owner-only.
											if (installTargetId(input?.target)) ownerOnly(ctx.auth, 'install an app on another computer')
											if (input?.oidc || input?.oidcIssuerUrl) ownerOnly(ctx.auth, 'manage single sign-on')
											return p.run(input, ctx)
										},
									},
								]
							: name === 'apps.installReview'
								? [
										name,
										{
											kind: p.kind,
											run: async (input, ctx) => {
												const res = await p.run(input, ctx)
												if (accounts.getUser(ctx.auth?.userId)?.role === 'member' && res?.oidc) {
													const {oidc: _drop, ...rest} = res
													return rest
												}
												return res
											},
										},
									]
								: [name, p],
			),
		),
		...Object.fromEntries(
			Object.entries(usb.procedures).map(([name, p]) =>
				name === 'usb.list' ? [name, p] : [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'attach USB devices'), p.run(input))}],
			),
		),
		...Object.fromEntries(Object.entries(backups.procedures).map(([name, p]) => [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage backups'), p.run(input))}])),
		...Object.fromEntries(Object.entries(unraid.procedures).map(([name, p]) => [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'move from Unraid'), p.run(input))}])),
		...Object.fromEntries(Object.entries(tailscale.procedures).map(([name, p]) => [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage Tailscale'), p.run(input))}])),
		...Object.fromEntries(Object.entries(connect.procedures).map(([name, p]) => [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage MODC Connect'), p.run(input))}])),
		...Object.fromEntries(
			Object.entries(oidc.procedures).map(([name, p]) => [
				name,
				{
					kind: p.kind,
					run: async (input, {auth}) => {
						ownerOnly(auth, 'manage single sign-on')
						const res = await p.run(input)
						if (name === 'oidc.setConfig') await apps.resyncOidcClients?.().catch(() => {})
						return res
					},
				},
			]),
		),
		...Object.fromEntries(
			Object.entries(updater.procedures).map(([name, p]) =>
				name === 'system.update' || name === 'system.setReleaseChannel' ? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'update this server'), p.run(input))}] : [name, p],
			),
		),
		// Running the installer needs sudo on the server: only the owner is asked.
		'system.installerStatus': {
			kind: 'query',
			run: (input, {auth}) => (accounts.getUser(auth?.userId)?.role !== 'owner' ? {needed: false, reasons: []} : updater.procedures['system.installerStatus'].run(input)),
		},
		'apps.getTorEnabled': {kind: 'query', run: () => false},
	}
	const assistant = createAssistant({
		dataDir,
		accounts,
		fetchImpl: assistantOptions.fetchImpl,
		chatgptOptions: assistantOptions.chatgpt ?? {},
		mcpTargets: () => apps.mcpTargets(),
		runProcedure: (name, input, auth) => {
			const p = procedures[name]
			if (!p) throw new RpcError('NOT_FOUND', 'Unknown tool')
			return p.run(input, {auth})
		},
	})
	Object.assign(procedures, assistant.procedures)
	// Hermes Agent, for people who already run it: chat through it, and let it look after this server.
	const hermes = createHermes({
		dataDir,
		home,
		omarchydPort: port,
		keys: assistant.keys,
		accounts,
		fetchImpl: assistantOptions.fetchImpl,
		sh: (cmd, args, timeout) => sh(cmd, args, timeout),
		log: (m) => console.log(m),
		runProcedure: (name, input, auth) => {
			const p = procedures[name]
			if (!p) throw new RpcError('NOT_FOUND', 'Unknown tool')
			return p.run(input, {auth})
		},
	})
	Object.assign(procedures, hermes.procedures)

	const omarchyTheme = createOmarchyTheme({home, ...themeOptions})
	const omarchyPlugins = createOmarchyPlugins({home, theme: omarchyTheme, ...pluginOptions})
	// Local swarm: other Linux computers joined through the connector (see connector.mjs).
	connector = createConnector({dataDir, tlsDir, connectorDir: join(appDir, 'connector'), plugins: omarchyPlugins, files, source: () => updater.source(), webPort, onOnline: (id) => machines.bootRemote(id)})
	const clipboardWrite = {
		async run(text) {
			throw new RpcError('PRECONDITION_FAILED', 'This server can’t take clipboard text right now')
		},
	}
	clips = createClips({
		dataDir,
		files,
		fleet: connector.files,
		readers: {
			writeClipboard: (text) => clipboardWrite.run(text),
			server: () => sampler.get(),
			machine: async (id) => {
				try {
					const list = await machines.procedures['machines.list'].run()
					const found = Array.isArray(list) ? list.find((m) => m.id === id) : null
					if (!found?.name) return null
					const stats = await machines.procedures['machines.stats'].run({id})
					return {name: found.name, stats}
				} catch {
					return null
				}
			},
			swarm: async (id) => {
				try {
					const list = await connector.procedures['swarm.list'].run()
					const found = Array.isArray(list) ? list.find((a) => a.id === id) : null
					if (!found?.name) return null
					return {name: found.name, stats: found.metrics}
				} catch {
					return null
				}
			},
		},
		roleOf: (userId) => accounts.getUser(userId)?.role,
		authenticate: (req) => accounts.authenticate(req),
		urlUser: (token, req) => accounts.checkUrlToken(token, req),
	})
	Object.assign(procedures, clips.procedures)
	toasts = createToasts({dataDir})
	Object.assign(procedures, toasts.procedures)
	transfers = createTransfers({
		dataDir,
		toasts,
		paste: (auth, clipId, dest) => clips.procedures['clips.paste'].run({id: clipId, dest}, {auth}),
		stat: async (path) => {
			try {
				const info = await files.inspect(path)
				if (!info || info.dir) return null
				return {size: info.size}
			} catch {
				return null
			}
		},
	})
	Object.assign(procedures, transfers.procedures)
	void transfers.kick()
	forwardInstall = (target, payload) => connector.forwardAppInstall(target, payload)
	remoteApps = () => connector.remoteApps()
	const transfer = createFileTransfer({files, fleet: connector.files})
	const crossesComputers = (input) => [input?.path, input?.toDirectory].some((p) => typeof p === 'string' && p.startsWith('::'))
	Object.assign(procedures, {
		'files.transfer': {
			kind: 'mutation',
			run: (input, {auth}) => {
				if (crossesComputers(input)) ownerOnly(auth, 'move files between computers')
				return transfer.transfer(input)
			},
		},
		'files.fleetRecents': {
			kind: 'query',
			run: (_input, {auth}) => (ownerOnly(auth, 'read files on other computers'), transfer.fleetRecents()),
		},
	})
	let signedInAt = 0
	// After a sign-in or remote unlock from the web, lock the desktop again once nobody is viewing it (Settings ->
	// Security), so the screen isn't left signed in at the server itself. A short wait lets a page
	// reload or a reconnect keep the session.
	let remoteSignIn = false
	let desktopViewers = 0
	let lockTimer = null
	const lockGraceMs = machineOptions.lockGraceMs ?? 60_000
	const scheduleRelockIfIdle = () => {
		if (desktopViewers || !remoteSignIn || security.lockAfterRemote === false) return
		clearTimeout(lockTimer)
		lockTimer = setTimeout(() => {
			if (desktopViewers) return
			remoteSignIn = false
			lockDesktop().catch((e) => console.error('[omarchyd] couldn’t lock the desktop:', e.message))
		}, lockGraceMs)
		lockTimer.unref?.()
	}
	const markRemoteSignIn = () => {
		signedInAt = Date.now()
		remoteSignIn = true
		scheduleRelockIfIdle()
	}
	const viewerJoined = () => {
		desktopViewers++
		clearTimeout(lockTimer)
	}
	const viewerLeft = () => {
		desktopViewers = Math.max(0, desktopViewers - 1)
		scheduleRelockIfIdle()
	}
	const hyprland = createHyprland({
		dataDir,
		home,
		onRemoteUnlock: markRemoteSignIn,
		...hyprlandOptions,
	})
	clipboardWrite.run = (text) => hyprland.procedures['hyprland.clipboardWrite'].run({text})
	Object.assign(
		procedures,
		Object.fromEntries(
			Object.entries(hyprland.procedures).map(([name, p]) => [
				name,
				{
					kind: p.kind,
					run: (input, {auth}) => {
						ownerOnly(auth, 'render the Hyprland desktop')
						if (factoryResetInProgress && p.kind === 'mutation') {
							throw new RpcError('CONFLICT', 'Factory reset is in progress')
						}
						return p.run(input)
					},
				},
			]),
		),
	)
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
	// Start at boot without a sign-in. MODC runs as your user's services, which systemd starts at boot
	// only when "linger" is on for you. The installer turns it on with sudo; when that didn't happen
	// (no sudo, an in-app update, an older install), a headless server stayed down after a power cut
	// until someone signed in. Your own linger can usually be turned on without sudo (logind allows it
	// for yourself), so try that once at startup and keep showing the state in Settings.
	const bootStart = {
		async state() {
			const r = await sh('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], 5_000)
			return r.ok ? r.out.trim() === 'yes' : null
		},
		async enable() {
			await sh('loginctl', ['enable-linger', os.userInfo().username], 15_000)
			return (await bootStart.state()) === true
		},
		// Linger only matters once the system has booted. An encrypted system disk (Omarchy's default)
		// asks for its password before anything on it runs, this server included, so after a restart the
		// computer waits at that screen. It boots by itself only when the disk unlocks itself (a TPM,
		// a FIDO key, a Tang server through Clevis, or the key file install.sh adds to the boot image when
		// the owner turns on unattended boot).
		async diskLock() {
			if (machineOptions.diskLock !== undefined) return machineOptions.diskLock
			const src = await sh('findmnt', ['-no', 'SOURCE', '/'], 5_000)
			if (!src.ok) return null
			const dev = src.out.trim().split('[')[0]
			if (!dev.startsWith('/dev/')) return {encrypted: false, unlocksItself: false}
			const stack = await sh('lsblk', ['-s', '-no', 'TYPE', dev], 5_000)
			if (!stack.ok) return null
			if (!stack.out.split(/\s+/).includes('crypt')) return {encrypted: false, unlocksItself: false}
			const text = (await Promise.all(['/proc/cmdline', '/etc/crypttab.initramfs', '/etc/crypttab'].map((f) => readFile(f, 'utf8').catch(() => '')))).join('\n')
			const exists = (f) => stat(f).then(() => true, () => false)
			const [clevis, unattended] = await Promise.all([exists('/usr/lib/initcpio/install/clevis'), exists(UNATTENDED_BOOT_CONF)])
			return {encrypted: true, unlocksItself: clevis || unattended || /tpm2-device|fido2-device/.test(text)}
		},
	}
	// Before a restart or shutdown: if this server wouldn't come back by itself (no linger), turn that
	// on first; if that isn't possible, refuse unless they chose to go ahead anyway. A restart from a
	// phone used to leave a server with no screen down until someone went and signed in at it.
	async function bootGuard(input, what) {
		if (appOptions.run || machineOptions.run) return
		const lock = await bootStart.diskLock().catch(() => null)
		if (what === 'restart' && lock?.encrypted && !lock.unlocksItself && input?.evenIfDiskLocked !== true)
			throw new RpcError(
				'PRECONDITION_FAILED',
				'DISK_LOCKED: This computer’s disk is encrypted, so after restarting it waits at its disk password screen. Nothing on it can start until someone types that password at the computer: not this server, and not remote access.',
			)
		if ((await bootStart.state()) !== false) return
		if (await bootStart.enable()) return
		if (input?.evenIfNoBootStart === true) return
		throw new RpcError(
			'PRECONDITION_FAILED',
			`BOOT_START_OFF: After ${what === 'restart' ? 'restarting' : 'shutting down'}, this server would stay off until someone signs in on it, and it couldn’t turn on starting at boot by itself. On the server, run: sudo loginctl enable-linger ${os.userInfo().username}`,
		)
	}
	if (!process.env.NODE_TEST_CONTEXT && !appOptions.run)
		setTimeout(async () => {
			if ((await bootStart.state()) !== false) return
			const ok = await bootStart.enable()
			console.log(ok ? '[omarchyd] turned on start at boot (loginctl enable-linger)' : `[omarchyd] this server won’t start after a restart until you sign in; run: sudo loginctl enable-linger ${os.userInfo().username}`)
		}, 15_000).unref?.()
	// machines-add-lxc (the one command that sets up containers) on the PATH beside omarchy-server.
	// The installer links it too; servers installed before it existed get the link here.
	if (!process.env.NODE_TEST_CONTEXT && !appOptions.run)
		(async () => {
			const target = join(appDir, 'bin', 'machines-add-lxc')
			const link = join(home, '.local', 'bin', 'machines-add-lxc')
			if (!(await stat(target).catch(() => null))) return
			const st = await lstat(link).catch(() => null)
			if (st && !st.isSymbolicLink()) return
			if (st && (await readlink(link).catch(() => '')) === target) return
			await mkdir(join(home, '.local', 'bin'), {recursive: true})
			if (st) await unlink(link)
			await symlink(target, link)
		})().catch(() => {})
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
	// Move an older install's desktop share from 127.0.0.1:5900 to the private socket, and give it
	// its own control socket (-S): wayvnc refuses to start while another one, such as a connected
	// computer's on this same desktop, holds the default. Updating is enough (no installer run).
	const DESKTOP_UNIT = `[Unit]
Description=MODC: share this Omarchy desktop with the web app (private socket)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStartPre=/usr/bin/mkdir -p -m 0700 %t/omarchy-server
ExecStartPre=/usr/bin/rm -f %t/omarchy-server/desktop-vnc.sock
ExecStart=/usr/bin/wayvnc --max-fps=30 -S %t/omarchy-server/wayvncctl --unix-socket %t/omarchy-server/desktop-vnc.sock
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`
	async function moveDesktopShare() {
		if (machineOptions.run) return
		const unit = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user/omarchy-server-desktop.service')
		const text = await readFile(unit, 'utf8').catch(() => null)
		if (text === null || text.includes('omarchy-server/wayvncctl')) return
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
			throw new RpcError('PRECONDITION_FAILED', 'Screen sharing (wayvnc) isn’t installed. Run the installer again to add it.')
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
		await sh('systemd-run', ['--user', '--collect', '--unit=omarchy-server-desktop-now', `--setenv=WAYLAND_DISPLAY=${socket}`, `--setenv=XDG_RUNTIME_DIR=${runtime}`, ...(hypr ? [`--setenv=HYPRLAND_INSTANCE_SIGNATURE=${hypr}`] : []), '/usr/bin/wayvnc', '--max-fps=30', '-S', join(dirname(desktopVncSocket), 'wayvncctl'), '--unix-socket', desktopVncSocket])
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
			if (await oidc.handleHttp(req, res, url)) return
			if (url.pathname === '/assistant/stream' && req.method === 'POST') {
				const auth = accounts.authenticate(req)
				if (!auth) return sendError(res, new RpcError('UNAUTHORIZED', 'Invalid token'))
				return await assistant.handleStream(req, res, auth)
			}
			if (url.pathname.startsWith('/trpc/')) return await handleRpc(req, res, url, procedures, (r) => accounts.authenticate(r) ?? apps.authenticatePublish(r))
			if (url.pathname === '/assets/wallpapers/1.jpg' && req.method === 'GET') return await wallpaper(res)
			// A computer's backup uploading to its own store (its connector's key; add-only, see backups.mjs).
			if (url.pathname.startsWith('/connector/backup/')) {
				const agentId = connector.backup.authenticate(req)
				if (!agentId) return sendJson(res, 401, {error: 'unauthorized'})
				return await backups.handleUpload(req, res, agentId, url.pathname.slice('/connector/backup/'.length))
			}
			// A connector updating itself from this server (authenticated with its own key).
			// The web server's remote-access gate reads its settings here: non-secret values only, and only
			// for a caller on this machine.
			// The web server's single-sign-on steps (connect-sso.mjs), on this machine only. Nothing secret
			// comes back except, after a verified website sign-in, the owner's local session.
			if (url.pathname.startsWith('/internal/sso/') && req.method === 'POST') {
				const a = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
				const step = url.pathname.slice('/internal/sso/'.length)
				if ((a !== '::1' && !/^127\./.test(a)) || !['start', 'finish', 'check', 'logout'].includes(step)) {
					res.writeHead(404).end()
					return
				}
				const chunks = []
				let size = 0
				for await (const c of req) {
					size += c.length
					if (size > 4096) break
					chunks.push(c)
				}
				let input = {}
				try {
					input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
				} catch {}
				const out = await connect.sso[step](input && typeof input === 'object' ? input : {}).catch(() => ({error: 'failed'}))
				res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'})
				res.end(JSON.stringify(out))
				return
			}
			if (url.pathname === '/internal/remote-gate' && req.method === 'GET') {
				const a = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
				if (a !== '::1' && !/^127\./.test(a)) {
					res.writeHead(404).end()
					return
				}
				res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'})
				res.end(JSON.stringify(connect.remoteGate()))
				return
			}
			if (url.pathname === '/connector/agent.py' && req.method === 'GET') {
				const agent = await connector.authenticateAgent(req)
				if (!agent) return sendJson(res, 401, {error: 'unauthorized'})
				const {bytes, sha256} = await connector.readAgentScript()
				res.writeHead(200, {'content-type': 'text/x-python; charset=utf-8', 'content-length': bytes.length, 'x-connector-sha256': sha256, 'cache-control': 'no-store'})
				return res.end(bytes)
			}
			// A connector trading its one-time pairing code for its own id and key.
			if (url.pathname === '/connector/enroll' && req.method === 'POST') {
				let size = 0
				const chunks = []
				for await (const c of req) {
					size += c.length
					if (size > 64 * 1024) return sendJson(res, 413, {error: 'Too large'})
					chunks.push(c)
				}
				let body = null
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
				} catch {
					return sendJson(res, 400, {error: 'Bad request'})
				}
				const r = await connector.enroll(body)
				return sendJson(res, r.status, r.body)
			}
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
				{
					let value = ''
					try {
						value = decodeURIComponent(cookie ?? '')
					} catch {
						return sendJson(res, 401, {})
					}
					return sendJson(res, apps.checkSession(value) ? 200 : 401, {})
				}
			}
			if (url.pathname === '/api/swarm/files/download' && req.method === 'GET') {
				const auth = accounts.authenticate(req) || accounts.checkUrlToken(url.searchParams.get('token'), req)
				if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
				ownerOnly(auth, 'download files from the local swarm')
				const id = url.searchParams.get('id') ?? ''
				const remotePath = url.searchParams.get('path') ?? ''
				const file = await connector.readRemoteFile(id, remotePath)
				res.writeHead(200, {
					'content-type': 'application/octet-stream',
					'content-length': file.data.length,
					'content-disposition': contentDisposition(file.name),
					'cache-control': 'no-store',
				})
				return res.end(file.data)
			}
			// Owner-only file download/upload for this server's containers (Incus), up to 100 MB.
			if (url.pathname === '/api/containers/files/download' && req.method === 'GET') {
				const auth = accounts.authenticate(req) || accounts.checkUrlToken(url.searchParams.get('token'), req)
				if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
				ownerOnly(auth, 'download files from containers')
				const file = await containers.readFile(url.searchParams.get('name') ?? '', url.searchParams.get('path') ?? '')
				res.writeHead(200, {
					'content-type': 'application/octet-stream',
					'content-length': file.data.length,
					'content-disposition': contentDisposition(file.name),
					'cache-control': 'no-store',
				})
				return res.end(file.data)
			}
			if (url.pathname === '/api/containers/files/upload' && req.method === 'POST') {
				const auth = accounts.authenticate(req)
				if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
				ownerOnly(auth, 'upload files to containers')
				let size = 0
				const chunks = []
				for await (const c of req) {
					size += c.length
					if (size > 100 * 1024 * 1024) return sendJson(res, 413, {error: 'Files larger than 100 MB can’t be uploaded this way'})
					chunks.push(c)
				}
				return sendJson(res, 200, await containers.writeFile(url.searchParams.get('name') ?? '', url.searchParams.get('path') ?? '', Buffer.concat(chunks)))
			}
			if (url.pathname === '/api/swarm/files/upload' && req.method === 'POST') {
				const auth = accounts.authenticate(req)
				if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
				ownerOnly(auth, 'upload files to the local swarm')
				const id = url.searchParams.get('id') ?? ''
				const remotePath = url.searchParams.get('path') ?? ''
				let size = 0
				const chunks = []
				for await (const c of req) {
					size += c.length
					if (size > 20 * 1024 * 1024) return sendJson(res, 413, {error: 'Files larger than 20 MB can’t be transferred through the swarm'})
					chunks.push(c)
				}
				const result = await connector.writeRemoteFile(id, remotePath, Buffer.concat(chunks))
				return sendJson(res, 200, result)
			}
			const fileKind = /^\/api\/files\/(view|download|upload|upload-chunk)$/.exec(url.pathname)?.[1]
			if ((fileKind === 'upload' || fileKind === 'upload-chunk') && req.method === 'POST') {
				const auth = accounts.authenticate(req)
				if (!auth || auth.kind !== 'browser') return sendJson(res, 401, {error: 'unauthorized'})
				return await (fileKind === 'upload' ? files.upload(req, res, url) : files.uploadChunk(req, res, url))
			}
			if ((fileKind === 'view' || fileKind === 'download') && req.method === 'GET') {
				if (!accounts.checkUrlToken(url.searchParams.get('token'), req)) return sendJson(res, 401, {error: 'unauthorized'})
				return await files.serveFile(req, res, url, fileKind)
			}
			if (url.pathname === '/api/clips/text' && req.method === 'POST') return await clips.httpText(req, res, url)
			if (url.pathname === '/api/clips/image' && req.method === 'POST') return await clips.httpImage(req, res, url)
			if (url.pathname === '/api/clips/item' && req.method === 'GET') return await clips.httpItem(req, res, url)
			if (url.pathname === '/hyprland/app-icon' && req.method === 'GET') {
				const auth = accounts.authenticate(req) || accounts.checkUrlToken(url.searchParams.get('token'), req)
				if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
				ownerOnly(auth, 'read native Linux app icons')
				const icon = await hyprland.readAppIcon(url.searchParams.get('id') ?? '')
				if (!icon) return sendJson(res, 404, {error: 'not found'})
				res.writeHead(200, {
					'content-type': icon.contentType,
					'content-length': icon.data.length,
					'content-security-policy': 'sandbox',
					'x-content-type-options': 'nosniff',
					'cache-control': 'private, max-age=3600',
				})
				return res.end(icon.data)
			}
			// This server's tools, for the Hermes agent connected in Settings › Assistant (its own token).
			if (url.pathname === '/mcp') return await hermes.handleMcp(req, res)
			if (url.pathname === '/hyprland/events' && req.method === 'GET') {
				const auth = accounts.authenticate(req)
				if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
				ownerOnly(auth, 'subscribe to Hyprland window events')
				if (allHyprSse.size >= 32) return sendJson(res, 503, {error: 'Too many active Hyprland event subscribers'})
				let closed = false
				let unsub = null
				let keepalive = null
				let buffering = true
				let bufferOverflow = false
				const buffered = []
				const sidKey = auth.sessionId || null
				const cleanup = () => {
					if (closed) return
					closed = true
					allHyprSse.delete(stopStream)
					if (sidKey) {
						const set = hyprSseBySession.get(sidKey)
						if (set) {
							set.delete(stopStream)
							if (set.size === 0) hyprSseBySession.delete(sidKey)
						}
					}
					if (keepalive) clearInterval(keepalive)
					keepalive = null
					if (unsub) unsub()
					unsub = null
				}
				const stopStream = () => {
					cleanup()
					try {
						if (!res.writableEnded) res.end()
					} catch {}
				}
				let lastSentSnapSeq = 0
				const writeEvt = (evt) => {
					if (closed || res.writableEnded) return
					if (evt?.type === 'windows' && typeof evt.seq === 'number') {
						if (evt.seq < lastSentSnapSeq) return
						lastSentSnapSeq = evt.seq
					}
					if (res.writableLength > 256 * 1024) {
						stopStream()
						return
					}
					res.write(`data: ${JSON.stringify(evt)}\n\n`)
				}
				// Subscribe BEFORE taking the initial snapshot (buffering events until an authoritative snapshot is written; if the buffer overflows, re-snapshot before resuming).
				unsub = hyprland.subscribeEvents((evt) => {
					if (closed) return
					if (buffering) {
						if (buffered.length >= 256) bufferOverflow = true
						else buffered.push(evt)
					} else {
						writeEvt(evt)
					}
				})
				if (!unsub) return sendJson(res, 503, {error: 'Too many active Hyprland event subscribers'})
				res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'})
				res.socket?.setNoDelay?.(true)
				allHyprSse.add(stopStream)
				if (sidKey) {
					let set = hyprSseBySession.get(sidKey)
					if (!set) {
						set = new Set()
						hyprSseBySession.set(sidKey, set)
					}
					set.add(stopStream)
				}
				req.on('close', cleanup)
				res.on('close', cleanup)
				const sockReady = await hyprland.waitForEventSocketReady?.(1500).catch(() => false)
				if (!sockReady || closed || req.destroyed || res.writableEnded) {
					stopStream()
					return
				}
				let snapOk = false
				for (let attempt = 0; attempt < 3; attempt++) {
					bufferOverflow = false
					buffered.length = 0
					const initSeq = hyprland.nextEventSnapSeq?.() ?? 0
					const [initial, instanceId] = await Promise.all([
						hyprland.windowsSnapshot().catch(() => null),
						hyprland.currentInstanceId().catch(() => null),
					])
					if (closed || req.destroyed || res.writableEnded) {
						cleanup()
						return
					}
					if (!Array.isArray(initial)) {
						stopStream()
						return
					}
					if (bufferOverflow) continue
					// If the socket's own syncAuthoritative() already buffered a newer snapshot while we queried, drop the stale initSeq snapshot and start from the newer one.
					const newerSnapIdx = buffered.findIndex((e) => e?.type === 'windows' && e.authoritative && typeof e.seq === 'number' && e.seq > initSeq)
					if (newerSnapIdx >= 0) {
						buffered.splice(0, newerSnapIdx)
					} else {
						writeEvt({type: 'windows', instanceId, windows: initial, authoritative: true, seq: initSeq})
					}
					snapOk = true
					break
				}
				if (!snapOk || closed || req.destroyed || res.writableEnded) {
					stopStream()
					return
				}
				buffering = false
				for (const evt of buffered.splice(0)) writeEvt(evt)
				if (closed || req.destroyed || res.writableEnded) {
					cleanup()
					return
				}
				keepalive = setInterval(() => {
					if (closed || res.writableEnded) return
					const stillAuthed = accounts.authenticate(req)
					if (!stillAuthed || accounts.getUser(stillAuthed.userId)?.role !== 'owner') {
						stopStream()
						return
					}
					if (res.writableLength > 256 * 1024) {
						stopStream()
						return
					}
					res.write(': ping\n\n')
				}, 20_000)
				keepalive.unref?.()
				return
			}
			sendJson(res, 404, {error: 'not found'})
		} catch (error) {
			if (!res.headersSent) sendError(res, error)
			else res.destroy()
		}
	})
	// VM screens: /machines/console?machineId=…&ticket=… (subprotocol "binary") <-> the machine's
	// VNC unix socket. Only reachable on localhost, and only with a fresh ticket.
	// Your shell runs in tmux, when it's installed, so it survives omarchyd restarts and updates.
	const terminals = createTerminalSessions({tmux: terminalTmux === undefined ? createTmux({conf: join(dataDir, 'terminal', 'tmux.conf')}) : terminalTmux})
	const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false})
	server.on('upgrade', async (req, socket, head) => {
		const refuse = (status) => {
			socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
			socket.destroy()
		}
		try {
			const url = new URL(req.url ?? '/', 'http://localhost')
			// A connector on another computer (it signs in with its own key, checked in connector.mjs).
			if (url.pathname === '/connector/ws') return await connector.upgradeAgent(req, socket, head)
			const route = {'/machines/console': 'machines', '/terminal': 'terminal', '/hyprland/stream': 'hyprland'}[url.pathname]
			if (!route) return refuse('404 Not Found')
			const t = tickets.get(url.searchParams.get('ticket') ?? '')
			tickets.delete(url.searchParams.get('ticket') ?? '')
			if (!t || t.expires < Date.now() || t.target !== route) return refuse('401 Unauthorized')
			const owner = (t.role ?? accounts.getUser(t.userId)?.role) === 'owner'
			if (route === 'hyprland') {
				if (factoryResetInProgress) return refuse('503 Service Unavailable')
				if (!owner) return refuse('403 Forbidden')
				if (req.headers.origin) {
					let originHost = null
					try {
						originHost = new URL(req.headers.origin).host
					} catch {}
					if (!originHost || originHost !== req.headers.host) return refuse('403 Forbidden')
				}
				const mode = url.searchParams.get('mode') === 'window' ? 'window' : 'output'
				const address = mode === 'window' ? (url.searchParams.get('address') ?? '') : ''
				if (mode === 'window' && !/^0x[0-9a-f]{4,16}$/i.test(address)) return refuse('400 Bad Request')
				const output = mode === 'output' ? (url.searchParams.get('output') ?? '') : ''
				if (output && !/^[A-Za-z0-9_.-]{1,32}$/.test(output)) return refuse('400 Bad Request')
				const fps = Number(url.searchParams.get('fps') ?? 60)
				const bitrate = Number(url.searchParams.get('bitrate') ?? 22000)
				const audio = url.searchParams.get('audio') === '1'
				const audioCodec = url.searchParams.get('audioCodec') === 'opus' ? 'opus' : 'pcm'
				const rawCodec = url.searchParams.get('codec') ?? 'h264'
				const codec = rawCodec === 'hevc444' || rawCodec === 'hevc10' || rawCodec === 'hevc' ? rawCodec : 'h264'
				const quality = Number(url.searchParams.get('quality') ?? 0)
				const compression = Number(url.searchParams.get('compression') ?? 0)
				const sidKey = t.sessionId || null
				return wss.handleUpgrade(req, socket, head, (ws) => {
					try {
						socket.setNoDelay?.(true)
					} catch {}
					if (sidKey) {
						let set = hyprSocketsBySession.get(sidKey)
						if (!set) {
							set = new Set()
							hyprSocketsBySession.set(sidKey, set)
						}
						set.add(ws)
						ws.once('close', () => {
							set.delete(ws)
							if (set.size === 0) hyprSocketsBySession.delete(sidKey)
						})
					}
					viewerJoined()
					ws.once('close', viewerLeft)
					hyprland.attachStream(ws, {mode, address, output, fps, bitrate, audio, audioCodec, codec, quality, compression}).catch(() => ws.close(1011, 'Hyprland stream failed'))
				})
			}
			// A shell: your own, or one inside an installed app's container.
			if (route === 'terminal') {
				// This process runs as the owner’s user, and a swarm computer’s terminal is the
				// same as managing the swarm (owner-only). Members can’t be given a different OS user.
				if (!owner) return refuse('403 Forbidden')
				const cols = Number(url.searchParams.get('cols'))
				const rows = Number(url.searchParams.get('rows'))
				if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 4 || rows > 300) return refuse('400 Bad Request')
				// A computer in the local swarm: its connector opens the shell.
				const agentId = url.searchParams.get('agentId')
				if (agentId) {
					if (!/^[0-9a-f]{12}$/.test(agentId)) return refuse('400 Bad Request')
					const sessionParam = url.searchParams.get('session') ?? ''
					const session = /^[A-Za-z0-9._-]{1,40}$/.test(sessionParam) ? sessionParam : 'main'
					const fresh = url.searchParams.get('fresh') === '1'
					return wss.handleUpgrade(req, socket, head, (ws) => connector.openChannel(agentId, 'pty', ws, {cols, rows, session, fresh}))
				}
				// A root shell inside one of this server's containers (Incus).
				const containerId = url.searchParams.get('containerId')
				if (containerId) {
					const mode = url.searchParams.get('containerMode') === 'console' ? 'console' : 'shell'
					const inContainer = await containers.shellFor(containerId, mode).catch(() => null)
					if (!inContainer) return refuse('409 Conflict')
					const fresh = url.searchParams.get('fresh') === '1'
					return wss.handleUpgrade(req, socket, head, (ws) =>
						terminals.attach(ws, {userId: t.userId, appId: `container:${containerId}:${mode}`, cols, rows, fresh, shell: {home, cwd: home, ...inContainer}}).catch(() => ws.close(1011, 'Couldn’t start a shell')),
					)
				}
				const appId = url.searchParams.get('appId')
				const inApp = appId ? await apps.shellFor(appId).catch(() => null) : null
				if (appId && !inApp) return refuse('409 Conflict')
				// Your shell keeps running when you close it; opening it again picks up where you left off.
				const fresh = url.searchParams.get('fresh') === '1'
				wss.handleUpgrade(req, socket, head, (ws) =>
					terminals.attach(ws, {userId: t.userId, appId: appId ?? '', cols, rows, fresh, shell: {home, ...(inApp ?? {}), cwd: inApp?.cwd ?? home}}).catch(() => ws.close(1011, 'Couldn’t start a shell')),
				)
				return
			}
			// "desktop" is this server's own Omarchy desktop, shared by wayvnc on 127.0.0.1 only.
			const machineId = url.searchParams.get('machineId') ?? ''
			// A computer in the local swarm: its connector shares its screen. Owner-only, like managing the swarm.
			if (connector.isAgentMachine(machineId)) {
				if (!owner) return refuse('403 Forbidden')
				return wss.handleUpgrade(req, socket, head, (ws) => connector.openChannel(machineId.slice(6), 'vnc', ws))
			}
			// This server's own desktop is the owner's signed-in Omarchy session: owner-only too.
			if (machineId === 'desktop' && !owner) return refuse('403 Forbidden')
			let target
			try {
				target = machineId === 'desktop' ? await desktopTarget() : await machines.vncSocket(machineId)
			} catch (error) {
				if (!(error instanceof RpcError)) throw error
				const message = closeReason(error.message)
				return wss.handleUpgrade(req, socket, head, (ws) => ws.close(1011, message))
			}
			if (!target) return refuse('409 Conflict')
			// Apps opened from the shared screen should open on it (not on the headless display).
			if (machineId === 'desktop') Promise.resolve().then(() => hyprland.focusSharedScreen?.()).catch(() => {})
			if (typeof target === 'object' && target.agentId) return wss.handleUpgrade(req, socket, head, (ws) => connector.openChannel(target.agentId, 'vnc', ws, {guest: target.guest}))
			const vnc = net.connect(typeof target === 'string' ? {path: target} : target)
			vnc.once('error', () => refuse('502 Bad Gateway'))
			vnc.once('connect', () => {
				vnc.removeAllListeners('error')
				wss.handleUpgrade(req, socket, head, (ws) => {
					if (machineId === 'desktop') {
						viewerJoined()
						ws.once('close', viewerLeft)
					}
					// A big burst (the whole screen after signing in) pauses the screen's source until the
					// viewer catches up; only a viewer that reads nothing for a long time is let go.
					const behind = viewerBackpressure(
						ws,
						vnc,
						() => {
							ws.close(1011, 'The viewer fell behind')
							vnc.destroy()
						},
						viewerStallMs ? {stallMs: viewerStallMs} : {},
					)
					vnc.on('data', (d) => {
						if (ws.readyState !== ws.OPEN) return
						ws.send(d, {binary: true})
						behind.check()
					})
					ws.on('message', (d) => vnc.write(d))
					vnc.on('close', () => ws.close(1000))
					vnc.on('error', () => ws.terminate())
					ws.on('close', () => (behind.stop(), vnc.destroy()))
					ws.on('error', () => (behind.stop(), vnc.destroy()))
				})
			})
		} catch {
			refuse('500 Internal Server Error')
		}
	})
	await apps.ready
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

	// Once: put the My Own Data Center icon in the Omarchy top bar (servers installed before the
	// icon supported Omarchy's own bar never got it). `omarchy-server widget off` removes it for good.
	const widgetMark = join(dataDir, '.top-bar-widget-added')
	const widgetBin = join(home, '.local', 'bin', 'omarchy-server')
	setTimeout(async () => {
		if (!appOptions.run && !(await readFile(widgetMark).then(() => true, () => false)) && (await readFile(widgetBin).then(() => true, () => false))) {
			const {execFile} = await import('node:child_process')
			execFile(widgetBin, ['widget', 'on'], {timeout: 30_000}, (err) => !err && writeFile(widgetMark, new Date().toISOString()).catch(() => {}))
		}
	}, 20_000).unref?.()

	return {url: `http://${host}:${server.address().port}`, accounts, terminals, hyprland, close: () => (sampler.stop(), connect.close(), apps.close(), backups.close(), unraid.close(), updater.stop(), connector.close(), revokeAllHyprStreams(), hyprland.close(), assistant.chatgpt.close(), terminals.close(), new Promise((r) => server.close(r)))}
}

// The "always use the secure address" choice made while omarchyd kept its own certificate folder.
async function carryOverTls(oldDir, newDir) {
	try {
		const old = await readPolicy(oldDir)
		if (!old.alwaysHttps) return
		if ((await readFile(join(newDir, 'policy.json'), 'utf8').catch(() => null)) !== null) return
		await writePolicy(newDir, old)
	} catch {
		/* nothing to carry over */
	}
}
