import http from 'node:http'
// My Own Data Center server: a same-origin backend for the PWA.
//
// Why it exists: omarchyd's browser login binds its token to an HttpOnly cookie on
// omarchyd's own origin and sends no CORS headers, so a separately hosted page
// cannot call it from the browser. omarchyd's *native* login (user.loginNative,
// the path server's own iOS/macOS apps use) returns bearer credentials instead.
// This server performs that login, keeps the credentials server-side, refreshes
// the 1-hour access token, and forwards only an explicit allowlist of calls.
// The phone only ever holds an opaque HttpOnly cookie for this server.

import {randomBytes, randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {networkInterfaces} from 'node:os'
import {join} from 'node:path'
import express from 'express'
import WebSocket, {WebSocketServer} from 'ws'

import {dualProtocolServer, wantsUpgrade} from '../omarchyd/tls.mjs'
import {linkProxy} from '../omarchyd/proxy-link.mjs'
import {viewerBackpressure} from '../omarchyd/backpressure.mjs'
import {createBackendClient, BackendError} from './backend.mjs'
import {hashId, newSessionId} from './store.mjs'
import {createQuickTransfer, cleanUploadName, PORTAL_JS, portalHtml} from './quick-transfer.mjs'

export const VERSION = '0.9.108'
const COOKIE = 'omarchy_server_sid'
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365
const REFRESH_MARGIN_MS = 2 * 60 * 1000

// Every omarchyd procedure the UI may reach, with its tRPC kind. Anything else
// (factory reset, password changes, repositories, network config…) is refused.
// Settings → Assistant → Assistant Appearance, saved with the account's other preferences.
export function cleanAssistantLook(v) {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return null
	const one = (x, ok, d) => (ok.includes(x) ? x : d)
	if (typeof v.character !== 'string' || !/^[a-z0-9-]{1,24}$/.test(v.character)) return null
	const name = String(v.name ?? '')
		.replace(/[\u0000-\u001f\u007f<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 24)
	return {
		character: v.character,
		name,
		animate: v.animate !== false,
		intensity: one(v.intensity, ['minimal', 'normal', 'playful'], 'normal'),
		size: one(v.size, ['small', 'medium', 'large'], 'medium'),
		floating: v.floating !== false,
		reactions: v.reactions !== false,
		position: spots(v.position),
	}
}
// Where the floating character sits, per layout, as fractions of the screen.
function spots(v) {
	const out = {}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return out
	for (const k of ['phone', 'desktop']) {
		const p = v[k]
		if (!p || typeof p !== 'object') continue
		const x = Number(p.x)
		const y = Number(p.y)
		if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
		const c = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1e4) / 1e4
		out[k] = {x: c(x), y: c(y)}
	}
	return out
}

export const ALLOWED = {
	'user.revokeAppPasses': 'mutation',
	'system.desktopSignIn': 'mutation',
	'system.security': 'query',
	'storage.growSystem': 'mutation',
	'system.setSecurity': 'mutation',
	'nix.cache': 'query',
	'nix.setCache': 'mutation',
	'system.replaceCertificate': 'mutation',
	'system.desktopShare': 'mutation',
	'apps.probe': 'query',
	'omarchy.themes': 'query',
	'omarchy.backgrounds': 'query',
	'omarchy.setTheme': 'mutation',
	'omarchy.setBackground': 'mutation',
	'omarchy.installTheme': 'mutation',
	'omarchy.removeTheme': 'mutation',
	'system.version': 'query',
	'system.status': 'query',
	'system.uptime': 'query',
	'system.deviceName': 'query',
	'system.cpuTemperature': 'query',
	'system.stats': 'query',
	'system.bootStart': 'query',
	'system.enableBootStart': 'mutation',
	'system.cpuUsage': 'query',
	'system.memoryUsage': 'query',
	'system.diskUsage': 'query',
	'system.gpuUsage': 'query',
	'system.batteryUsage': 'query',
	'system.getIpAddresses': 'query',
	'system.checkUpdate': 'query',
	'system.installerStatus': 'query',
	'user.get': 'query',
	'apps.list': 'query',
	'apps.state': 'query',
	'apps.details': 'query',
	'apps.updates': 'query',
	'apps.recentlyOpened': 'query',
	'apps.logs': 'query',
	'apps.installReview': 'query',
	'appStore.registry': 'query',
	'appStore.app': 'query',
	'appStore.repositories': 'query',
	'machines.list': 'query',
	'containers.status': 'query',
	'containers.hostStatus': 'query',
	'containers.list': 'query',
	'containers.images': 'query',
	'containers.create': 'mutation',
	'containers.start': 'mutation',
	'containers.stop': 'mutation',
	'containers.restart': 'mutation',
	'containers.forceStop': 'mutation',
	'containers.delete': 'mutation',
	'containers.snapshot': 'mutation',
	'containers.restoreSnapshot': 'mutation',
	'containers.deleteSnapshot': 'mutation',
	'containers.addPort': 'mutation',
	'containers.removePort': 'mutation',
	'containers.templates': 'query',
	'containers.stats': 'query',
	'containers.backups': 'query',
	'containers.files': 'query',
	'containers.setResources': 'mutation',
	'containers.setOptions': 'mutation',
	'containers.clone': 'mutation',
	'containers.saveTemplate': 'mutation',
	'containers.deleteTemplate': 'mutation',
	'containers.backup': 'mutation',
	'containers.restoreBackup': 'mutation',
	'containers.deleteBackup': 'mutation',
	'containers.copyToServer': 'mutation',
	'containers.setRootPassword': 'mutation',
	'containers.templateFiles': 'query',
	'containers.importTemplate': 'mutation',
	'containers.downloadTemplate': 'mutation',
	'containers.installConnector': 'mutation',
	'containers.nixosConfig': 'query',
	'containers.setNixosConfig': 'mutation',
	'containers.applyNixosConfig': 'mutation',
	'usb.list': 'query',
	'usb.attach': 'mutation',
	'usb.detach': 'mutation',
	'notifications.get': 'query',
	'apps.start': 'mutation',
	'apps.stop': 'mutation',
	'apps.restart': 'mutation',
	'apps.update': 'mutation',
	'apps.install': 'mutation',
	'appStore.addRepository': 'mutation',
	'appStore.removeRepository': 'mutation',
	'appStore.refresh': 'mutation',
	'omarchy.plugins': 'query',
	'swarm.list': 'query',
	'swarm.files.recents': 'query',
	'swarm.history': 'query',
	'swarm.alerts': 'query',
	'swarm.wake': 'mutation',
	'swarm.pair': 'mutation',
	'swarm.reauthorize': 'mutation',
	'swarm.updateConnector': 'mutation',
	'swarm.updateAllConnectors': 'mutation',
	'swarm.remove': 'mutation',
	'swarm.rename': 'mutation',
	'swarm.setAbilities': 'mutation',
	'swarm.action': 'mutation',
	'swarm.storage.status': 'query',
	'swarm.vms.status': 'query',
	'swarm.storage.disks': 'query',
	'swarm.storage.pools': 'query',
	'swarm.storage.importable': 'query',
	'swarm.storage.unmount': 'mutation',
	'swarm.storage.mount': 'mutation',
	'swarm.storage.format': 'mutation',
	'swarm.storage.createPool': 'mutation',
	'swarm.storage.addToPool': 'mutation',
	'swarm.storage.importPool': 'mutation',
	'swarm.storage.forgetPool': 'mutation',
	'swarm.storage.scrub': 'mutation',
	'swarm.storage.setSleep': 'mutation',
	'swarm.services.list': 'query',
	'swarm.services.logs': 'query',
	'swarm.services.control': 'mutation',
	'swarm.files.list': 'query',
	'swarm.files.mkdir': 'mutation',
	'swarm.files.rename': 'mutation',
	'swarm.files.trash': 'mutation',
	'swarm.files.copyToServer': 'mutation',
	'swarm.files.copyFromServer': 'mutation',
	'assistant.keys': 'query',
	'hermes.status': 'query',
	'hermes.connect': 'mutation',
	'hermes.disconnect': 'mutation',
	'hermes.setMode': 'mutation',
	'hermes.connectRemote': 'mutation',
	'hermes.remoteSetup': 'query',
	'hermes.rotateToken': 'mutation',
	'assistant.setEngine': 'mutation',
	'assistant.addKey': 'mutation',
	'assistant.updateKey': 'mutation',
	'assistant.reorderKeys': 'mutation',
	'assistant.clearDefault': 'mutation',
	'assistant.useServerDefault': 'mutation',
	'assistant.removeKey': 'mutation',
	'assistant.verifyKey': 'mutation',
	'assistant.chatgptStart': 'mutation',
	'assistant.chatgptFinish': 'mutation',
	'assistant.chatgptStatus': 'query',
	'assistant.models': 'query',
	'assistant.conversations': 'query',
	'assistant.getConversation': 'query',
	'assistant.deleteConversation': 'mutation',
	'assistant.stop': 'mutation',
	'assistant.approve': 'mutation',
	'assistant.reject': 'mutation',
	'omarchy.installPlugin': 'mutation',
	'omarchy.removePlugin': 'mutation',
	'hyprland.status': 'query',
	'hyprland.windows': 'query',
	'hyprland.apps': 'query',
	'hyprland.launch': 'mutation',
	'hyprland.dispatch': 'mutation',
	'hyprland.clipboardRead': 'query',
	'hyprland.clipboardWrite': 'mutation',
	'hyprland.profiles': 'query',
	'hyprland.profileRun': 'mutation',
	'hyprland.profileSave': 'mutation',
	'hyprland.profileDelete': 'mutation',
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
	'machines.localIsos': 'query',
	'machines.isoDownloads': 'query',
	'machines.downloadIso': 'mutation',
	'machines.create': 'mutation',
	'machines.installConnector': 'mutation',
	'machines.uninstall': 'mutation',
	'machines.updateSettings': 'mutation',
	'machines.pause': 'mutation',
	'machines.resume': 'mutation',
	'machines.hibernate': 'mutation',
	'machines.node': 'query',
	'machines.details': 'query',
	'machines.stats': 'query',
	'machines.tasks': 'query',
	'machines.updateHardware': 'mutation',
	'machines.updateOptions': 'mutation',
	'machines.setBootOrder': 'mutation',
	'machines.addDisk': 'mutation',
	'machines.updateDisk': 'mutation',
	'machines.resizeDisk': 'mutation',
	'machines.removeDisk': 'mutation',
	'machines.addCdrom': 'mutation',
	'machines.setMedia': 'mutation',
	'machines.updateCloudInit': 'mutation',
	'machines.snapshot': 'mutation',
	'machines.revertSnapshot': 'mutation',
	'machines.deleteSnapshot': 'mutation',
	'machines.backups': 'query',
	'machines.backup': 'mutation',
	'machines.restoreBackup': 'mutation',
	'machines.deleteBackup': 'mutation',
	// Backups to a NAS (owner only, checked in omarchyd)
	'backups.status': 'query',
	'backups.discover': 'query',
	'backups.snapshots': 'query',
	'backups.shares': 'mutation',
	'backups.configure': 'mutation',
	'backups.recoveryKey': 'mutation',
	'backups.keySaved': 'mutation',
	'backups.runNow': 'mutation',
	'backups.restoreApp': 'mutation',
	'backups.connectExisting': 'mutation',
	'backups.computers': 'query',
	'backups.computerFolders': 'mutation',
	'backups.setComputer': 'mutation',
	'backups.runComputer': 'mutation',
	'backups.computerSnapshots': 'query',
	'backups.restoreComputer': 'mutation',
	'backups.gdrive.status': 'query',
	'backups.gdrive.authStart': 'mutation',
	'backups.gdrive.authFinish': 'mutation',
	'backups.gdrive.configure': 'mutation',
	'backups.gdrive.test': 'mutation',
	'backups.gdrive.connectExisting': 'mutation',
	'backups.gdrive.disconnect': 'mutation',
	// Move from Unraid (owner only, checked in omarchyd)
	'unraid.status': 'query',
	'unraid.connect': 'mutation',
	'unraid.scan': 'mutation',
	'unraid.preflight': 'mutation',
	'unraid.start': 'mutation',
	'unraid.resync': 'mutation',
	'unraid.cancel': 'mutation',
	'unraid.disconnect': 'mutation',
	'unraid.forgetHost': 'mutation',
	'machines.clone': 'mutation',
	'machines.monitor': 'mutation',
	'machines.nixosConfig': 'query',
	'machines.setNixosConfig': 'mutation',
	'machines.applyNixosConfig': 'mutation',
	// Storage (NAS): drives, pools, sleep
	'storage.status': 'query',
	'storage.disks': 'query',
	'storage.pools': 'query',
	'storage.importable': 'query',
	'storage.createPool': 'mutation',
	'storage.addToPool': 'mutation',
	'storage.importPool': 'mutation',
	'storage.forgetPool': 'mutation',
	'storage.scrub': 'mutation',
	'storage.setSleep': 'mutation',
	'storage.unmount': 'mutation',
	'storage.mount': 'mutation',
	'storage.format': 'mutation',
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
	// This server's Tailscale mesh. Owner only, checked in omarchyd.
	'tailscale.status': 'query',
	'tailscale.setPrefs': 'mutation',
	'tailscale.login': 'mutation',
	'tailscale.logout': 'mutation',
	'tailscale.ping': 'mutation',
	// This server as an OpenID Connect provider. Owner only, checked in omarchyd.
	'oidc.status': 'query',
	'oidc.setConfig': 'mutation',
	'oidc.clients': 'query',
	'oidc.createClient': 'mutation',
	'oidc.updateClient': 'mutation',
	'oidc.rotateSecret': 'mutation',
	'oidc.deleteClient': 'mutation',
	'apps.oidcStatus': 'query',
	'apps.setOidc': 'mutation',
	// Settings: advanced (omarchyd itself re-checks the password for factory reset)
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
	'files.transfer': 'mutation',
	'files.fleetRecents': 'query',
	'files.trash': 'mutation',
	'files.restore': 'mutation',
	'files.delete': 'mutation',
	'files.emptyTrash': 'mutation',
	'files.operationProgress': 'query',
	'files.shares': 'query',
	'files.addShare': 'mutation',
	'files.updateShare': 'mutation',
	'files.shareOptions': 'query',
	'files.setSharePassword': 'mutation',
	'files.removeShare': 'mutation',
	'files.sharePassword': 'query',
	'files.externalDevices': 'query',
	'files.unmountExternalDevice': 'mutation',
	'files.getThumbnail': 'mutation',
	'files.unarchive': 'mutation',
	// Storage: the same calls My Own Data Center's Storage Manager makes. hardware.raid.setup is
	// deliberately absent: omarchyd marks it dev-only, and on a running server it writes a RAID
	// config the next boot mounts as the data drive, i.e. an empty pool in place of your data.
	'hardware.internalStorage.getDevices': 'query',
	'hardware.raid.getStatus': 'query',
	'hardware.raid.addDevice': 'mutation',
	'hardware.raid.addMirror': 'mutation',
	'hardware.raid.addAccelerator': 'mutation',
	'hardware.raid.replaceDevice': 'mutation',
	'hardware.raid.transitionToFailsafeRaidz': 'mutation',
	'hardware.raid.scrub': 'mutation',
	'clips.list': 'query',
	'clips.addText': 'mutation',
	'clips.addStats': 'mutation',
	'clips.addFile': 'mutation',
	'clips.remove': 'mutation',
	'clips.paste': 'mutation',
	'clips.fleetList': 'query',
	'toasts.list': 'query',
	'toasts.add': 'mutation',
	'toasts.dismiss': 'mutation',
	'transfers.list': 'query',
	'transfers.start': 'mutation',
	'transfers.resume': 'mutation',
	'transfers.cancel': 'mutation',
	'transfers.dismiss': 'mutation',
}

// Long-running mutations: omarchyd answers when the operation finishes.
export const SLOW = new Set(['containers.create', 'containers.images', 'containers.setRootPassword', 'containers.setNixosConfig', 'containers.applyNixosConfig', 'containers.installConnector', 'containers.templateFiles', 'containers.importTemplate', 'containers.downloadTemplate', 'machines.downloadIso', 'containers.files', 'containers.copyToServer', 'containers.setResources', 'containers.clone', 'containers.saveTemplate', 'containers.backup', 'containers.restoreBackup', 'containers.stop', 'containers.restart', 'containers.delete', 'containers.snapshot', 'containers.restoreSnapshot', 'hyprland.launch', 'hermes.connect', 'hermes.connectRemote', 'hermes.disconnect', 'hyprland.profileRun', 'unraid.connect', 'unraid.scan', 'unraid.preflight', 'unraid.resync', 'tailscale.login', 'tailscale.ping', 'oidc.setConfig', 'apps.setOidc', 'backups.configure', 'backups.shares', 'backups.restoreApp', 'backups.connectExisting', 'backups.snapshots', 'backups.computerSnapshots', 'backups.setComputer', 'backups.computerFolders', 'backups.gdrive.authFinish', 'backups.gdrive.configure', 'backups.gdrive.test', 'backups.gdrive.connectExisting', 'storage.growSystem', 'system.replaceCertificate', 'system.desktopSignIn', 'system.desktopShare', 'omarchy.removeTheme', 'storage.disks', 'storage.createPool', 'storage.addToPool', 'storage.importPool', 'storage.forgetPool', 'files.addShare', 'files.removeShare', 'files.copy', 'files.unarchive', 'files.getThumbnail', 'files.move', 'files.delete', 'files.emptyTrash', 'files.search', 'files.list', 'swarm.files.list', 'swarm.files.recents', 'files.transfer', 'files.fleetRecents', 'apps.install', 'apps.update', 'apps.uninstall', 'apps.start', 'apps.stop', 'apps.restart', 'appStore.registry', 'appStore.app', 'appStore.addRepository', 'appStore.refresh', 'omarchy.plugins', 'omarchy.installPlugin', 'files.updateShare', 'files.setSharePassword', 'apps.logs', 'swarm.action', 'system.update', 'system.logs', 'machines.create', 'machines.installConnector', 'machines.uninstall', 'machines.snapshot', 'machines.revertSnapshot', 'machines.deleteSnapshot', 'machines.resizeDisk', 'machines.addDisk', 'machines.restart', 'machines.applyNixosConfig', 'machines.start', 'machines.hibernate', 'machines.updateCloudInit', 'machines.details', 'machines.node', 'wifi.connect', 'wifi.networks', 'system.setHostname', 'hardware.internalStorage.getDevices', 'hardware.raid.addDevice', 'hardware.raid.addMirror', 'hardware.raid.addAccelerator', 'hardware.raid.replaceDevice', 'hardware.raid.transitionToFailsafeRaidz', 'storage.unmount', 'storage.mount', 'storage.format', 'swarm.storage.disks', 'swarm.storage.unmount', 'swarm.storage.mount', 'swarm.storage.format', 'swarm.storage.pools', 'swarm.storage.importable', 'swarm.storage.createPool', 'swarm.storage.addToPool', 'swarm.storage.importPool', 'swarm.storage.forgetPool', 'swarm.storage.scrub', 'assistant.approve', 'clips.paste', 'clips.addFile', 'clips.fleetList', 'swarm.updateConnector', 'swarm.updateAllConnectors', 'swarm.services.list', 'swarm.services.logs', 'swarm.services.control', 'swarm.files.copyToServer', 'swarm.files.copyFromServer'])
export const timeoutFor = (path) => (SLOW.has(path) ? 30 * 60 * 1000 : 20_000)

// An IPv6 address in a URL needs brackets; req.hostname and URL.hostname may already have them.
const bracketHost = (h) => (String(h).includes(':') && !String(h).startsWith('[') ? `[${h}]` : String(h))

// The host an Origin header names. "null" and other unparseable origins name none, so they never match.
function hostOf(origin) {
	try {
		return new URL(origin).host
	} catch {
		return null
	}
}

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
	return {id: 'omarchy-server', platform, deviceClass, appVersion: VERSION, appBuild: '1', osVersion: 'web'}
}

// omarchyd returns {id, brandColorHsl} (e.g. "259 100% 59%"); pass through only safe values.
export function wallpaperOf(w) {
	if (!w || typeof w !== 'object') return null
	const id = /^\d{1,3}$/.test(String(w.id)) ? String(w.id) : null
	const brand = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(String(w.brandColorHsl)) ? String(w.brandColorHsl) : null
	return id ? {id, brandColorHsl: brand} : null
}

const isLoopback = (hostname) => hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname)

export function normalizeBackendUrl(input) {
	let value = String(input ?? '').trim()
	if (!value) throw new Error('Enter your server’s address')
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]
	if (scheme && !/^https?$/i.test(scheme)) throw new Error(`An address can’t start with ${scheme}://. Use an http:// or https:// address, or just the IP address or name`)
	// A bare IPv6 address (more than one colon, no brackets) needs brackets to be a URL host.
	if (!scheme && !value.startsWith('[') && !value.includes('/') && (value.match(/:/g) ?? []).length > 1) value = `[${value}]`
	if (!scheme) value = `http://${value}`
	let url
	try {
		url = new URL(value)
	} catch {
		// Node's own text is just "Invalid URL": say what is wrong and what to type instead.
		const port = /^https?:\/\/[^/?#\s]*?(?:\]|[^:\]]):([^:/?#\]]*)(?:[/?#]|$)/i.exec(value)?.[1]
		if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
			throw new Error('The port in that address isn’t right. Use a number from 1 to 65535, like 192.168.1.50:7780')
		}
		throw new Error('That doesn’t look like an address. Try something like 192.168.1.50 or omarchy.local')
	}
	if (url.username || url.password) throw new Error('The address must not contain a username or password')
	return `${url.protocol}//${url.host}`
}

// Banner addresses for one bind. 0.0.0.0 and :: keep the LAN list; a loopback host is
// localhost only; any other address is printed by itself.
export function startupUrls(host, port, interfaces = networkInterfaces()) {
	const pair = (address) => [`http://${address}:${port}`, `https://${address}:${port}`]
	if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return pair('localhost')
	if (host !== '0.0.0.0' && host !== '::') {
		const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
		return pair(shown)
	}
	const lan = Object.values(interfaces ?? {})
		.flat()
		.filter((i) => i && i.family === 'IPv4' && !i.internal)
		.flatMap((i) => pair(i.address))
	return lan.length ? lan : [`http://localhost:${port}`]
}

export function normalizeAppHosts(input) {
	const p = String(input ?? '').trim().toLowerCase()
	if (!p || p === 'off') return null
	if (!/^[a-z0-9.-]*\{app\}[a-z0-9.-]*$/.test(p) || !p.includes('.') || p.startsWith('.') || p.endsWith('.') || p.includes('..')) {
		throw new Error('must look like {app}-touch.example.com (or "off" to clear)')
	}
	return p
}

export function createApp({store, staticDir, connectorDir = staticDir ? join(staticDir, '..', 'connector') : '', fetchImpl = fetch, secureCookies = false, tls = null, relayPortBase = Number(process.env.TOUCH_APP_PORT_BASE ?? 7800), relayHost = process.env.HOST ?? '0.0.0.0'}) {
	const app = express()
	app.disable('x-powered-by')
	app.set('trust proxy', 'loopback')
	// This server's certificate authority, for devices to trust its https:// pages (public by nature).
	app.get('/api/tls/ca.crt', (_req, res) => {
		const ca = tls?.ca()
		if (!ca) return res.status(404).type('text/plain').send('HTTPS isn’t set up on this server')
		res.set({'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="omarchy-server.crt"', 'cache-control': 'no-store'})
		res.send(ca)
	})
	app.get('/api/tls/status', (_req, res) => res.json({available: !!tls?.get(), alwaysHttps: !!tls?.policy?.().alwaysHttps}))
	// The connector installer, for a guest whose copy of this server lives in a local directory
	// (curl cannot fetch that path). Public, like the certificate above: the guest is not signed in yet.
	const connectorFiles = new Map([
		['install.sh', 'text/plain; charset=utf-8'],
		['agent.py', 'text/plain; charset=utf-8'],
		['helper.py', 'text/plain; charset=utf-8'],
		['vm-helper.py', 'text/plain; charset=utf-8'],
		['lxc-helper.py', 'text/plain; charset=utf-8'],
		['install.ps1', 'text/plain; charset=utf-8'],
	])
	app.get('/api/connector/:name', async (req, res) => {
		const type = connectorFiles.get(req.params.name)
		if (!type || !connectorDir) return res.status(404).type('text/plain').send('Not found')
		const body = await readFile(join(connectorDir, req.params.name), 'utf8').catch(() => null)
		if (body == null) return res.status(404).type('text/plain').send('Not found')
		res.set({'content-type': type, 'cache-control': 'no-store'}).send(body)
	})
	// "Always use the secure address" (Settings → Security): page loads over http:// go to https://.
	// The certificate download above stays reachable either way.
	app.use((req, res, next) => {
		const host = req.headers.host ?? ''
		if (!wantsUpgrade(req, tls?.policy?.(), tls?.get()) || !/^(\[[0-9a-f:.]+\]|[a-z0-9.-]{1,253})(:\d{1,5})?$/i.test(host)) return next()
		res.set('cache-control', 'no-store').redirect(308, `https://${host}${req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') ? req.originalUrl : '/'}`)
	})

	const transfers = createQuickTransfer()
	let client = null
	const getClient = () => {
		const {backendUrl} = store.getConfig()
		if (!backendUrl) return null
		if (!client || client.baseUrl !== backendUrl) client = createBackendClient({baseUrl: backendUrl, fetchImpl})
		return client
	}

	// Desktop mode opens Apps in windows, i.e. frames of http(s)://<backend host>:<app port>.
	// Allow exactly that host (any port) and nothing else. The Host header is client-controlled,
	// so only a plain hostname or IP makes it into the policy.
	const frameHost = (req) => {
		const c = getClient()
		if (!c) return null
		const upstream = new URL(c.baseUrl).hostname
		const host = isLoopback(upstream) ? req.hostname : upstream
		return /^[a-z0-9.-]{1,253}$/i.test(host ?? '') || /^\[[0-9a-f:.]{2,45}\]$/i.test(host ?? '') ? host : null
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

	// OpenID Connect. Public discovery, keys, token, and userinfo. The sign-in form carries its own CSRF cookie, never this server's session cookie.
	const proxyOidc = (req, res) => {
		const backend = getClient()
		const isAuthorize = req.path === '/oidc/authorize'
		if (!backend) {
			if (isAuthorize) return res.status(503).type('text/html').send('<!doctype html><meta charset="utf-8"><p>This server isn’t ready right now. Try again shortly.</p>')
			return res.status(503).json({error: 'server_unavailable'})
		}
		let target
		try {
			target = new URL(req.originalUrl, backend.baseUrl)
		} catch {
			return res.status(400).end()
		}
		if (target.origin !== new URL(backend.baseUrl).origin) return res.status(400).end()
		const trustedProxy = isLoopback(String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''))
		const forwardedHost = trustedProxy ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : ''
		const headers = {
			'x-forwarded-host': forwardedHost || String(req.headers.host ?? ''),
			'x-forwarded-proto': req.protocol === 'https' ? 'https' : 'http',
		}
		for (const h of ['authorization', 'content-type', 'content-length', 'accept']) {
			if (req.headers[h]) headers[h] = req.headers[h]
		}
		if (isAuthorize && req.headers.cookie) {
			const oidcCsrf = parseCookies(req.headers.cookie).OMARCHY_OIDC_CSRF
			if (oidcCsrf) headers.cookie = `OMARCHY_OIDC_CSRF=${encodeURIComponent(oidcCsrf)}`
		}
		const up = http.request(target, {method: req.method, headers}, (ur) => {
			const out = {}
			for (const h of ['content-type', 'content-length', 'location', 'set-cookie', 'cache-control', 'pragma', 'www-authenticate', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'content-security-policy', 'x-content-type-options', 'referrer-policy']) {
				if (ur.headers[h] !== undefined) out[h] = ur.headers[h]
			}
			if (out['content-security-policy']) res.removeHeader('Content-Security-Policy')
			res.writeHead(ur.statusCode ?? 502, out)
			ur.pipe(res)
		})
		up.setTimeout(isAuthorize ? 45_000 : 15_000, () => up.destroy())
		linkProxy(req, res, up)
		up.on('error', () => {
			if (res.headersSent) return
			if (isAuthorize) {
				res.writeHead(502, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
				return res.end('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;background:#0f1117;color:#eef2ff;display:grid;place-items:center;min-height:100vh;margin:0"><p>Sign-in timed out or the server is busy. Wait a moment and try again.</p></body>')
			}
			res.writeHead(502, {'content-type': 'application/json; charset=utf-8'})
			res.end(JSON.stringify({error: 'server_error'}))
		})
		req.pipe(up)
	}
	app.get('/.well-known/openid-configuration', proxyOidc)
	app.options('/.well-known/openid-configuration', proxyOidc)
	app.get('/oidc/jwks.json', proxyOidc)
	app.options('/oidc/jwks.json', proxyOidc)
	app.get('/oidc/authorize', proxyOidc)
	app.post('/oidc/authorize', proxyOidc)
	app.post('/oidc/token', proxyOidc)
	app.options('/oidc/token', proxyOidc)
	app.get('/oidc/userinfo', proxyOidc)
	app.post('/oidc/userinfo', proxyOidc)
	app.options('/oidc/userinfo', proxyOidc)

	// The connector on another computer trading its one-time pairing code for its own key
	// (omarchyd checks the code; nothing else is reachable without a key).
	// A body that is not JSON, or too large, gets the short JSON answer omarchyd gives, not Express's HTML error page.
	const enrollBodyError = (error, _req, res, next) => {
		if (res.headersSent) return next(error)
		const status = Number(error?.status ?? error?.statusCode)
		if (!(status >= 400 && status < 500)) return next(error)
		res.status(status).json({error: status === 413 ? 'Too large' : 'Bad request'})
	}
	app.post('/connector/enroll', express.json({limit: '64kb'}), enrollBodyError, async (req, res) => {
		try {
			const r = await fetchImpl(`${getClient().baseUrl}/connector/enroll`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(req.body ?? {}), signal: AbortSignal.timeout(15_000)})
			res.status(r.status).json(await r.json().catch(() => ({})))
		} catch {
			res.status(502).json({error: 'The server isn’t answering right now'})
		}
	})
	// A connector fetching the bundled agent.py for self-update (omarchyd checks its key).
	app.get('/connector/agent.py', async (req, res) => {
		const backend = getClient()
		if (!backend) return res.status(503).end()
		try {
			const headers = {}
			if (req.headers.authorization) headers.authorization = req.headers.authorization
			const r = await fetchImpl(`${backend.baseUrl}/connector/agent.py`, {method: 'GET', headers, signal: AbortSignal.timeout(30_000)})
			const buf = Buffer.from(await r.arrayBuffer())
			res.status(r.status)
			for (const h of ['content-type', 'x-connector-sha256', 'cache-control']) {
				const v = r.headers.get(h)
				if (v) res.set(h, v)
			}
			res.end(buf)
		} catch {
			res.status(502).json({error: 'The server isn’t answering right now'})
		}
	})
	// A computer in the local swarm backing up to this server: its restic's requests, streamed to
	// omarchyd as they are (omarchyd checks the connector's key and keeps them to its own store).
	app.all('/connector/backup/*', (req, res) => {
		const backend = getClient()
		if (!backend) return res.status(503).end()
		// This route is not signed in. `new URL` collapses ".." and decodes %2e%2e, so a path
		// that still matches this route can land on /trpc or any other omarchyd route.
		const rawPath = req.originalUrl.split('?')[0]
		if (rawPath.includes('\\') || rawPath.includes('\0')) return res.status(400).end()
		let target
		try {
			target = new URL(req.originalUrl, backend.baseUrl)
		} catch {
			return res.status(400).end()
		}
		if (target.origin !== new URL(backend.baseUrl).origin || !target.pathname.startsWith('/connector/backup/')) return res.status(400).end()
		const headers = {}
		for (const h of ['authorization', 'content-type', 'content-length', 'range', 'accept']) if (req.headers[h]) headers[h] = req.headers[h]
		const up = http.request(target, {method: req.method, headers}, (ur) => {
			const out = {}
			for (const h of ['content-type', 'content-length', 'content-range', 'cache-control']) if (ur.headers[h]) out[h] = ur.headers[h]
			res.writeHead(ur.statusCode ?? 502, out)
			ur.pipe(res)
		})
		up.setTimeout(10 * 60_000, () => up.destroy())
		linkProxy(req, res, up)
		up.on('error', () => {
			if (res.headersSent) return
			res.writeHead(502, {'content-type': 'text/plain'})
			res.end()
		})
		req.pipe(up)
	})
	const api = express.Router()
	const json64k = express.json({limit: '64kb'})
	const jsonClipboard = express.json({limit: '256kb'})
	// omarchyd takes up to 100,000 bytes for one assistant message, so the proxy must not cut it at 64 KB.
	const jsonAssistant = express.json({limit: 100_000})
	api.use((req, res, next) => {
		if (req.path === '/rpc/hyprland.clipboardWrite') return jsonClipboard(req, res, next)
		if (req.path === '/assistant/stream') return jsonAssistant(req, res, next)
		return json64k(req, res, next)
	})
	api.use((req, res, next) => {
		res.set('Cache-Control', 'no-store')
		req.sid = parseCookies(req.headers.cookie)[COOKIE]
		if (req.sid) rememberSid(req.sid)
		// CSRF: state-changing calls must come from our own page.
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			const origin = req.headers.origin
			if (req.headers['x-omarchy-server'] !== '1' || (origin && hostOf(origin) !== req.headers.host)) {
				return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Cross-site request refused'}})
			}
		}
		shareAppSession(req, res, store.getSession(req.sid))
		if (req.sid) {
			keepAppPassFresh(req.sid)
			keepBrowserSessionFresh(req.sid)
		}
		// Settings › Devices shows when each device was last used: note it, at most once a minute.
		const seen = store.getSession(req.sid)
		if (seen && Date.now() - (seen.lastSeenAt ?? 0) > 60_000) store.updateSession(req.sid, {lastSeenAt: Date.now()}).catch(() => {})
		next()
	})

	// One sign-in for everything: the main sign-in also gets My Own Data Center's app session
	// (OMARCHY_APP_SESSION). Handing it to this browser as a cookie means every app's gateway
	// (each on its own port of this same host; cookies ignore ports) lets the browser straight in,
	// whether the app opens here, in a window or in its own tab. Over HTTPS, apps go through the
	// relay, which adds the session itself, so the cookie is only given out on plain-HTTP access.
	const appSessionValue = (session) => {
		const m = /^OMARCHY_APP_SESSION=([^;]+)/.exec(session?.console?.appCookie ?? '')
		return m ? m[1] : null
	}
	function shareAppSession(req, res, session) {
		const value = appSessionValue(session)
		if (!value || req.secure) return
		if (parseCookies(req.headers.cookie).OMARCHY_APP_SESSION === value) return
		res.append('Set-Cookie', `OMARCHY_APP_SESSION=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`)
	}

	const sendError = (res, error) => {
		if (error instanceof BackendError) {
			return res.status(error.status >= 400 ? error.status : 502).json({error: {code: error.code, message: error.message}})
		}
		console.error('[omarchy-server]', error)
		return res.status(500).json({error: {code: 'INTERNAL', message: 'Something went wrong in My Own Data Center'}})
	}

	// Express 4 does not turn a rejected async handler into a response, so a failed settings save
	// has to be caught here or the process exits.
	const catchSave = (handler, message = 'Couldn’t save that') => (req, res) => {
		Promise.resolve(handler(req, res)).catch((error) => {
			console.error('[omarchy-server]', error)
			if (res.headersSent) return
			try {
				res.status(500).json({error: {code: 'INTERNAL', message}})
			} catch (sendFailure) {
				console.error('[omarchy-server]', sendFailure)
			}
		})
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
		const backend = getClient()
		if (!backend) throw new BackendError('The My Own Data Center backend (omarchyd) isn’t set up yet', {code: 'NOT_CONFIGURED', status: 409})
		const session = store.getSession(req.sid)
		if (!session) throw new BackendError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		const timeout = timeoutFor(path)
		const run = async (token) =>
			kind === 'mutation' ? backend.mutation(path, input, {token, timeout}) : backend.query(path, input, {token, timeout})
		try {
			// Split refresh from the procedure. A revoked device whose token is already inside the
			// refresh window fails here, before the call, with "Invalid native session" — not "Invalid token".
			let token
			try {
				token = await accessTokenFor(req.sid, session)
			} catch (error) {
				if (error instanceof BackendError && error.code === 'UNAUTHORIZED') await store.deleteSession(req.sid)
				throw error
			}
			return await run(token)
		} catch (error) {
			if (!(error instanceof BackendError) || error.code !== 'UNAUTHORIZED') throw error
			// A wrong password is unauthorized too. Only an expired access token is refreshed and retried.
			// Sending a password or authenticator code again would count as a second failed attempt.
			if (error.message !== 'Invalid token') throw error
			if (session.mode === 'legacy') {
				await store.deleteSession(req.sid)
				throw error
			}
			// The access token may have been revoked or expired early: refresh once and retry.
			let token
			try {
				token = await accessTokenFor(req.sid, store.getSession(req.sid) ?? session, {force: true})
			} catch (refreshError) {
				if (refreshError instanceof BackendError && refreshError.code === 'UNAUTHORIZED') {
					await store.deleteSession(req.sid) // session revoked in My Own Data Center Settings
				}
				throw refreshError
			}
			return run(token)
		}
	}

	// ---- Bootstrap / setup ---------------------------------------------------
	api.get('/bootstrap', async (req, res) => {
		const backend = getClient()
		const session = store.getSession(req.sid)
		const out = {
			touch: {version: VERSION},
			configured: !!backend,
			server: null,
			accounts: [],
			session: session ? {accountId: session.accountId, mode: session.mode, console: !!session.console} : null,
		}
		if (!backend) return res.json(out)
		// When Touch runs on the server itself it talks to 127.0.0.1; the phone must
		// use the address it reached us on instead.
		const upstream = new URL(backend.baseUrl)
		const local = isLoopback(upstream.hostname)
		const host = local ? req.hostname : upstream.hostname
		// The page was reached on a port as well (7780 by default): keep it, so the link isn't port 80.
		let pageHost = req.hostname
		try {
			pageHost = new URL(`${req.protocol}://${req.headers.host}`).host || pageHost
		} catch {}
		const publicUrl = local ? `${req.protocol}://${pageHost}` : backend.baseUrl
		try {
			const [version, discovery, accounts] = await Promise.all([
				backend.query('system.version'),
				backend.query('system.discoveryInfo').catch(() => null),
				backend.query('user.listAccounts').catch(() => []),
			])
			out.server = {
				url: publicUrl,
				host,
				reachable: true,
				version: version?.version,
				name: version?.name,
				// When it last started and its exact build: for signed-in people only (before sign-in,
				// nothing more than the version, so the sign-in page doesn't tell anyone when it restarts).
				...(session ? {startedAt: version?.startedAt, revision: version?.revision} : {}),
				device: discovery?.device ?? null,
				onboarded: discovery?.onboarded ?? true,
				// How a browser tab reaches an app from this page (issue #86): see appAccess.
				appAccess: appAccess(req),
			}
			const mapped = (accounts ?? []).map((a) => ({
				userId: a.userId,
				name: a.name,
				avatar: a.avatarUrl?.startsWith('/api/accounts/') ? `/api/account-avatar?path=${encodeURIComponent(a.avatarUrl)}` : null,
				wallpaper: wallpaperOf(a.wallpaper),
			}))
			// Before sign-in, say nothing about who has an account here: the sign-in page asks for
			// a username and a password. Only the wallpaper (for the backdrop) is shared.
			out.accounts = session ? mapped : mapped.slice(0, 1).map((a) => ({userId: '', name: '', avatar: null, wallpaper: a.wallpaper}))
		} catch (error) {
			out.server = {url: local ? '' : backend.baseUrl, host, local, reachable: false, error: error.message}
		}
		res.json(out)
	})

	api.post('/setup', async (req, res) => {
		const configured = !!store.getConfig().backendUrl
		// Repointing an already-configured server needs a signed-in session, so nobody
		// on the network can aim it at a look-alike to collect passwords.
		if (configured && !store.getSession(req.sid)) {
			return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Sign in first to change the server address'}})
		}
		// …and only the owner may (a family member's account can't repoint it to collect the
		// owner's password). If the current backend can't be asked, a signed-in session still will do.
		if (configured) {
			const me = await authedCall(req, 'user.get', 'query').catch(() => null)
			if (me?.role === 'member') return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Only the server’s owner can change the server address'}})
		}
		let url
		try {
			url = normalizeBackendUrl(req.body?.url)
		} catch (error) {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: error.message}})
		}
		try {
			const probe = createBackendClient({baseUrl: url, fetchImpl, timeoutMs: 8000})
			const version = await probe.query('system.version')
			if (!version?.version) throw new BackendError('That address answered, but not like My Own Data Center', {status: 502})
			if (configured && url !== store.getConfig().backendUrl) {
				closeAllSessionStreams()
				await store.clearSessions()
			}
			await store.setConfig({backendUrl: url})
			res.json({ok: true, url, version: version.version, name: version.name})
		} catch (error) {
			sendError(res, error)
		}
	})

	// The account's own My Own Data Center wallpaper, served from the user's server. My Own Data Center
	// ships an AVIF and a JPEG of each; the id is validated so only those can be read.
	api.get('/wallpaper/:id', async (req, res) => {
		const backend = getClient()
		const id = req.params.id
		if (!backend || !/^\d{1,3}$/.test(id)) return res.status(404).end()
		const tier = req.query.size === 'thumb' ? 'thumbnails' : 'medium'
		// The .jpg is the desktop's current background (the same picture under id 1 whatever it is today),
		// so it keeps the type it really has and is never cached as unchanging.
		for (const [path, type] of [
			[`/assets/wallpapers/generated-avif/${tier}/${id}.avif`, 'image/avif'],
			[`/assets/wallpapers/${id}.jpg`, null],
		]) {
			try {
				const upstream = await fetchImpl(`${backend.baseUrl}${path}`, {signal: AbortSignal.timeout(10_000)})
				const upstreamType = upstream.headers.get('content-type') ?? ''
				if (!upstream.ok || !upstreamType.startsWith('image/')) continue
				res.set({'Content-Type': type ?? upstreamType, 'Cache-Control': type ? 'public, max-age=604800, immutable' : 'no-cache'})
				return res.send(Buffer.from(await upstream.arrayBuffer()))
			} catch {
				/* try the next format */
			}
		}
		res.status(404).end()
	})

	// The Omarchy desktop's themes and backgrounds, for the web app's Omarchy theme. The desktop's
	// current background is shown on the sign-in screen too; the rest need a signed-in browser.
	api.get('/omarchy/themes', async (req, res) => {
		const backend = getClient()
		if (!requireSession(req, res)) return
		try {
			const r = await fetchImpl(`${backend.baseUrl}/omarchy/themes`, {signal: AbortSignal.timeout(10_000)})
			res.status(r.ok ? 200 : 502).json(r.ok ? await r.json() : {error: {code: 'UNAVAILABLE', message: 'Couldn’t read Omarchy’s themes'}})
		} catch {
			res.status(502).json({error: {code: 'UNAVAILABLE', message: 'Couldn’t read Omarchy’s themes'}})
		}
	})
	api.get('/omarchy/background/:id', async (req, res) => {
		const backend = getClient()
		const id = req.params.id
		if (!backend || !/^(current|[0-9a-f]{16})$/.test(id)) return res.status(404).end()
		if (id !== 'current' && !store.getSession(req.sid)) return res.status(401).end()
		try {
			const r = await fetchImpl(`${backend.baseUrl}/omarchy/background/${id}`, {signal: AbortSignal.timeout(20_000)})
			const type = r.headers.get('content-type') ?? ''
			if (!r.ok || !type.startsWith('image/')) return res.status(404).end()
			res.set({'Content-Type': type, 'Cache-Control': id === 'current' ? 'no-cache' : 'private, max-age=86400'})
			res.send(Buffer.from(await r.arrayBuffer()))
		} catch {
			res.status(404).end()
		}
	})

	// A theme's preview picture, for Settings → Appearance → Omarchy → Themes.
	api.get('/omarchy/preview/:slug', async (req, res) => {
		const backend = getClient()
		const slug = req.params.slug
		if (!backend || !/^[a-z0-9_][a-z0-9._+-]{0,80}$/.test(slug) || !store.getSession(req.sid)) return res.status(404).end()
		try {
			const r = await fetchImpl(`${backend.baseUrl}/omarchy/preview/${slug}`, {signal: AbortSignal.timeout(20_000)})
			const type = r.headers.get('content-type') ?? ''
			if (!r.ok || !type.startsWith('image/')) return res.status(404).end()
			res.set({'Content-Type': type, 'Cache-Control': 'private, max-age=3600'})
			res.send(Buffer.from(await r.arrayBuffer()))
		} catch {
			res.status(404).end()
		}
	})

	// Owner-only file download/upload to a swarm computer (proxied to omarchyd with the session token).
	api.get('/swarm/files/download', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const backend = getClient()
		const id = String(req.query.id ?? '')
		const remotePath = String(req.query.path ?? '')
		if (!/^[0-9a-f]{12}$/.test(id) || !remotePath) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Missing file parameters'}})
		try {
			const qs = new URLSearchParams({id, path: remotePath}).toString()
			const r = await fetchImpl(`${backend.baseUrl}/api/swarm/files/download?${qs}`, {
				method: 'GET',
				headers: {authorization: `Bearer ${await accessTokenFor(req.sid, session)}`},
				signal: AbortSignal.timeout(120_000),
			})
			const buf = Buffer.from(await r.arrayBuffer())
			res.status(r.status)
			for (const h of ['content-type', 'content-disposition', 'cache-control']) {
				const v = r.headers.get(h)
				if (v) res.set(h, v)
			}
			res.end(buf)
		} catch {
			res.status(502).json({error: {code: 'UNAVAILABLE', message: 'Couldn’t download file from that computer'}})
		}
	})
	// Owner-only file download/upload for this server's containers (proxied to omarchyd, which checks the owner).
	const CONTAINER_NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
	api.get('/containers/files/download', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const backend = getClient()
		const name = String(req.query.name ?? '')
		const path = String(req.query.path ?? '')
		if (!CONTAINER_NAME.test(name) || !path.startsWith('/')) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Missing file parameters'}})
		try {
			const r = await fetchImpl(`${backend.baseUrl}/api/containers/files/download?${new URLSearchParams({name, path})}`, {
				headers: {authorization: `Bearer ${await accessTokenFor(req.sid, session)}`},
				signal: AbortSignal.timeout(180_000),
			})
			const buf = Buffer.from(await r.arrayBuffer())
			res.status(r.status)
			for (const h of ['content-type', 'content-disposition', 'cache-control']) {
				const v = r.headers.get(h)
				if (v) res.set(h, v)
			}
			res.end(buf)
		} catch {
			res.status(502).json({error: {code: 'UNAVAILABLE', message: 'Couldn’t download the file from that container'}})
		}
	})
	api.post('/containers/files/upload', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const backend = getClient()
		const name = String(req.query.name ?? '')
		const path = String(req.query.path ?? '')
		if (!CONTAINER_NAME.test(name) || !path.startsWith('/')) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Missing file parameters'}})
		try {
			let size = 0
			const chunks = []
			for await (const c of req) {
				size += c.length
				if (size > 100 * 1024 * 1024) return res.status(413).json({error: {code: 'BAD_REQUEST', message: 'Files larger than 100 MB can’t be uploaded this way'}})
				chunks.push(c)
			}
			const r = await fetchImpl(`${backend.baseUrl}/api/containers/files/upload?${new URLSearchParams({name, path})}`, {
				method: 'POST',
				headers: {authorization: `Bearer ${await accessTokenFor(req.sid, session)}`, 'content-type': 'application/octet-stream'},
				body: Buffer.concat(chunks),
				signal: AbortSignal.timeout(180_000),
			})
			res.status(r.status).json(await r.json().catch(() => ({})))
		} catch {
			res.status(502).json({error: {code: 'UNAVAILABLE', message: 'Couldn’t upload the file to that container'}})
		}
	})
	api.post('/swarm/files/upload', async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const backend = getClient()
		const id = String(req.query.id ?? '')
		const remotePath = String(req.query.path ?? '')
		if (!/^[0-9a-f]{12}$/.test(id) || !remotePath) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Missing file parameters'}})
		try {
			let size = 0
			const chunks = []
			for await (const c of req) {
				size += c.length
				if (size > 20 * 1024 * 1024) return res.status(413).json({error: {code: 'BAD_REQUEST', message: 'Files larger than 20 MB can’t be transferred through the swarm'}})
				chunks.push(c)
			}
			const qs = new URLSearchParams({id, path: remotePath}).toString()
			const r = await fetchImpl(`${backend.baseUrl}/api/swarm/files/upload?${qs}`, {
				method: 'POST',
				headers: {authorization: `Bearer ${await accessTokenFor(req.sid, session)}`, 'content-type': 'application/octet-stream'},
				body: Buffer.concat(chunks),
				signal: AbortSignal.timeout(120_000),
			})
			res.status(r.status).json(await r.json().catch(() => ({})))
		} catch {
			res.status(502).json({error: {code: 'UNAVAILABLE', message: 'Couldn’t upload file to that computer'}})
		}
	})

	api.get('/account-avatar', async (req, res) => {
		const backend = getClient()
		const path = String(req.query.path ?? '')
		if (!backend || !/^\/api\/accounts\/[\w.\-/]+$/.test(path) || path.includes('..')) return res.status(404).end()
		try {
			const upstream = await fetchImpl(`${backend.baseUrl}${path}`, {signal: AbortSignal.timeout(8000)})
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
	api.post('/auth/login', catchSave(async (req, res) => {
		const backend = getClient()
		if (!backend) return res.status(409).json({error: {code: 'NOT_CONFIGURED', message: 'Connect to your server first'}})
		const ip = req.ip ?? 'unknown'
		const now = Date.now()
		const LOGIN_WINDOW_MS = 5 * 60 * 1000
		const recent = (attempts.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS)
		if (recent.length >= 10) {
			const retryAfter = Math.max(1, Math.ceil((recent[0] + LOGIN_WINDOW_MS - now) / 1000))
			return res.set('Retry-After', String(retryAfter)).status(429).json({error: {code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Wait a few minutes.'}})
		}
		attempts.set(ip, [...recent, now])

		const {password, totpToken, username} = req.body ?? {}
		if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Enter your username and password'}})
		}
		// Every sign-in needs the account's name and its password. The name is matched here, on
		// the server, and a wrong name and a wrong password give the same answer.
		const WRONG = {error: {code: 'UNAUTHORIZED', message: 'Incorrect username or password'}}
		const known = await backend.query('user.listAccounts').catch(() => null)
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
			const result = await backend.mutation('user.loginNative', {...credentials, client: nativeClient}, {userAgent})
			session = {
				mode: 'native',
				accountId: result.accountId,
				accessToken: result.accessToken,
				accessExpiresAt: result.accessExpiresAt,
				deviceToken: result.deviceToken,
				client: nativeClient,
			}
		} catch (error) {
			// My Own Data Center before 2.0 has no native login; its user.login returns a bearer JWT.
			if (error instanceof BackendError && /incorrect password/i.test(error.message)) return res.status(401).json(WRONG)
			if (!(error instanceof BackendError) || error.code !== 'NOT_FOUND') return sendError(res, error)
			try {
				const token = await backend.mutation('user.login', credentials, {userAgent})
				if (typeof token !== 'string') throw new BackendError('Unsupported My Own Data Center version', {status: 502})
				session = {mode: 'legacy', accountId: userId ?? 'owner', accessToken: token}
			} catch (legacyError) {
				if (legacyError instanceof BackendError && /incorrect password/i.test(legacyError.message)) return res.status(401).json(WRONG)
				return sendError(res, legacyError)
			}
		}
		// The VM console needs a WebSocket ticket, which omarchyd only issues to browser
		// sessions (not native ones). Hold a second, browser-style session server-side
		// for that single purpose. Failing to get one only disables the console.
		if (session.mode === 'native') {
			session.console = await openConsoleSession(backend, credentials, userAgent, session.accessToken).catch(() => null)
		}
		attempts.delete(ip)
		const sid = newSessionId()
		await store.putSession(sid, {...session, createdAt: now, lastSeenAt: now, userAgent: String(userAgent ?? '').slice(0, 200)})
		rememberSid(sid)
		setCookie(res, sid, SESSION_MAX_AGE_S)
		shareAppSession(req, res, session)
		res.json({ok: true, accountId: session.accountId, mode: session.mode})
	}, 'Couldn’t sign you in. Try again.'))

	api.post('/auth/logout', catchSave(async (req, res) => {
		const session = store.getSession(req.sid)
		if (session?.console) {
			await getClient()
				?.mutation('user.logout', undefined, {token: session.console.token, cookie: session.console.cookie})
				.catch(() => {})
		}
		if (session) {
			// Revoke the My Own Data Center session too, so it disappears from Settings › Devices.
			await authedCall(req, 'user.logout', 'mutation').catch(() => {})
			forgetUrlToken(req.sid)
			await store.deleteSession(req.sid)
		}
		setCookie(res, '', 0)
		res.append('Set-Cookie', 'OMARCHY_APP_SESSION=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
		res.json({ok: true})
	}, 'Couldn’t sign you out. Try again.'))

	// ---- Saved appearance (per My Own Data Center account, shared by all its phones) -------
	const THEME_IDS = ['horizon', 'mocha', 'tokyo', 'gruvbox', 'latte', 'linen', 'sky', 'custom', 'omarchy']
	const DARK_THEME_IDS = ['mocha', 'tokyo', 'gruvbox']
	const LIGHT_THEME_IDS = ['latte', 'linen', 'sky']
	const PICTURE_THEME_IDS = ['horizon', 'custom', 'omarchy']
	const ACCENT_IDS = ['wallpaper', 'blue', 'mauve', 'teal', 'peach', 'green', 'pink']
	const HSL = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/
	const accountKey = (accountId) => hashId(`account:${accountId}`).slice(0, 32)
	const backgroundFile = (accountId) => join(store.dataDir, 'backgrounds', `${accountKey(accountId)}.jpg`)
	const TEMP_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/
	const STAT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/
	const cleanIdList = (value, pattern) => {
		if (value == null) return []
		if (!Array.isArray(value)) return null
		const out = []
		for (const id of value) {
			if (typeof id !== 'string' || !pattern.test(id) || out.includes(id)) return null
			out.push(id)
			if (out.length > 40) return null
		}
		return out
	}
	const cleanPicks = (value, pattern) => {
		if (value == null || typeof value !== 'object' || Array.isArray(value)) return {ok: false}
		const on = cleanIdList(value.on, pattern)
		const off = cleanIdList(value.off, pattern)
		if (!on || !off) return {ok: false}
		const hidden = off.filter((id) => !on.includes(id))
		return {ok: true, value: on.length || hidden.length ? {on, off: hidden} : null}
	}
	const cleanTempPicks = (value) => cleanPicks(value, TEMP_ID)
	const cleanStatPicks = (value) => cleanPicks(value, STAT_ID)
	const prefsOf = (accountId) => store.getConfig().prefs?.[accountKey(accountId)] ?? null
	const savePrefs = async (accountId, patch) => {
		const key = accountKey(accountId)
		let saved
		await store.setConfig((current) => {
			const all = {...(current.prefs ?? {})}
			const prev = all[key] ?? {}
			// rev: counted here, on the server, so every browser can tell it has the latest without
			// trusting its own clock.
			saved = {...prev, ...patch, rev: (Number(prev.rev) || 0) + 1}
			all[key] = saved
			return {prefs: all}
		})
		return saved
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
	api.post('/prefs', catchSave(async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const {theme, darkTheme, lightTheme, pictureTheme, accent, customBrandHsl, omarchyBackground, solidColor, assistantLook, statView, machinesCompact, statPicks, tempPicks, tempUnit, dismissedTutorials} = req.body ?? {}
		const patch = {}
		// How the assistant looks for this account (character, name, motion). Appearance only: it never
		// reaches the assistant itself. Checked field by field; anything else is dropped.
		if (assistantLook !== undefined) {
			const look = cleanAssistantLook(assistantLook)
			if (assistantLook !== null && !look) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad assistant appearance'}})
			patch.assistantLook = look
		}
		if (solidColor !== undefined) {
			if (solidColor !== null && !/^#[0-9a-f]{6}$/i.test(String(solidColor))) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad colour'}})
			patch.solidColor = solidColor === null ? null : String(solidColor).toLowerCase()
		}
		if (omarchyBackground !== undefined) {
			if (omarchyBackground !== null && (typeof omarchyBackground !== 'string' || !/^[0-9a-f]{16}$/.test(omarchyBackground))) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown background'}})
			patch.omarchyBackground = omarchyBackground
		}
		if (theme !== undefined) {
			if (!THEME_IDS.includes(theme)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown theme'}})
			patch.theme = theme
		}
		if (darkTheme !== undefined) {
			if (!DARK_THEME_IDS.includes(darkTheme)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown dark theme'}})
			patch.darkTheme = darkTheme
		}
		if (lightTheme !== undefined) {
			if (!LIGHT_THEME_IDS.includes(lightTheme)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown light theme'}})
			patch.lightTheme = lightTheme
		}
		if (pictureTheme !== undefined) {
			if (!PICTURE_THEME_IDS.includes(pictureTheme)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown picture theme'}})
			patch.pictureTheme = pictureTheme
		}
		if (accent !== undefined) {
			if (!ACCENT_IDS.includes(accent)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown accent'}})
			patch.accent = accent
		}
		if (customBrandHsl !== undefined) {
			if (customBrandHsl !== null && (typeof customBrandHsl !== 'string' || !HSL.test(customBrandHsl))) {
				return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad colour'}})
			}
			patch.customBrandHsl = customBrandHsl
		}
		// How this account draws machine stats. Home's aggregate gauges do not read it.
		if (statView !== undefined) {
			if (statView !== null && statView !== 'line' && statView !== 'blocks' && statView !== 'gauges') return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown stat view'}})
			patch.statView = statView
		}
		// Desktop Machines compact list for this account. Absent means off.
		if (machinesCompact !== undefined) {
			if (typeof machinesCompact !== 'boolean') return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad compact setting'}})
			patch.machinesCompact = machinesCompact
		}
		// Notes this account has closed. One id is one note, on every device.
		if (dismissedTutorials !== undefined) {
			const allowed = ['machines-filters']
			if (!Array.isArray(dismissedTutorials) || dismissedTutorials.some((id) => typeof id !== 'string' || !allowed.includes(id))) {
				return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Unknown tutorial'}})
			}
			patch.dismissedTutorials = [...new Set(dismissedTutorials)]
		}
		// Celsius, or Fahrenheit. Null and "c" both mean Celsius.
		if (tempUnit !== undefined) {
			if (tempUnit === null || tempUnit === 'c') patch.tempUnit = null
			else if (tempUnit === 'f') patch.tempUnit = 'f'
			else return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad temperature unit'}})
		}
		// Which readings this account shows. Temperatures stay in tempPicks. Null clears the choice.
		// A reading that was never chosen stays shown. Another account is unchanged.
		if (statPicks !== undefined) {
			if (statPicks === null) patch.statPicks = null
			else {
				const picks = cleanStatPicks(statPicks)
				if (!picks.ok) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad stat choice'}})
				patch.statPicks = picks.value
			}
		}
		// Which temperature sensors this account shows. Null clears the choice.
		if (tempPicks !== undefined) {
			if (tempPicks === null) patch.tempPicks = null
			else {
				const picks = cleanTempPicks(tempPicks)
				if (!picks.ok) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad temperature choice'}})
				patch.tempPicks = picks.value
			}
		}
		res.json({prefs: await savePrefs(session.accountId, patch)})
	}))

	// The desktop's own layout and look (wallpaper, style, dock, icons), per account, so every
	// browser you sign in on shows the same desktop. The browser checks the contents when it reads them.
	api.get('/desktop', (req, res) => {
		const session = requireSession(req, res)
		if (session) res.json({desktop: store.getConfig().desktops?.[accountKey(session.accountId)] ?? null})
	})
	api.post('/desktop', catchSave(async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const config = req.body?.config
		if (!config || typeof config !== 'object' || Array.isArray(config)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Bad desktop settings'}})
		const text = JSON.stringify(config)
		if (text.length > 60_000) return res.status(413).json({error: {code: 'PAYLOAD_TOO_LARGE', message: 'Desktop settings are too large'}})
		const key = accountKey(session.accountId)
		const parsed = JSON.parse(text)
		let saved
		await store.setConfig((current) => {
			const all = {...(current.desktops ?? {})}
			// The latest change saved wins. rev and updatedAt come from the server (not a browser's clock,
			// which can be off between devices), so every browser can tell it has the newest.
			const prevRev = Number(all[key]?.rev) || (all[key] ? 1 : 0)
			saved = {config: parsed, rev: prevRev + 1, updatedAt: Date.now()}
			all[key] = saved
			return {desktops: all}
		})
		res.json({desktop: saved})
	}))

	// Custom background: the phone resizes the photo to a JPEG before sending it.
	// The live file is replaced only after prefs commit, so a failed save can't show a new photo under the old version.
	api.post('/background', express.raw({type: 'image/jpeg', limit: '8mb'}), catchSave(async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const body = req.body
		const isJpeg = Buffer.isBuffer(body) && body.length > 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
		if (!isJpeg) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'That image couldn’t be read. Try a JPEG or PNG.'}})
		const dir = join(store.dataDir, 'backgrounds')
		await mkdir(dir, {recursive: true, mode: 0o700})
		const live = backgroundFile(session.accountId)
		const tmp = join(dir, `.${accountKey(session.accountId)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
		let prefs
		try {
			await writeFile(tmp, body, {mode: 0o600})
			prefs = await savePrefs(session.accountId, {backgroundVersion: Date.now()})
		} catch (error) {
			await rm(tmp, {force: true}).catch((cleanup) => console.error('[omarchy-server]', cleanup))
			throw error
		}
		await rename(tmp, live)
		res.json({prefs})
	}))
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
	api.delete('/background', catchSave(async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const live = backgroundFile(session.accountId)
		const aside = `${live}.${process.pid}.${randomBytes(4).toString('hex')}.bak`
		let moved = false
		try {
			await rename(live, aside)
			moved = true
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
		}
		const current = prefsOf(session.accountId) ?? {}
		let prefs
		try {
			prefs = await savePrefs(session.accountId, {
				backgroundVersion: null,
				customBrandHsl: null,
				...(current.theme === 'custom' ? {theme: 'horizon', pictureTheme: 'horizon'} : {}),
			})
		} catch (error) {
			if (moved) await rename(aside, live).catch((restore) => console.error('[omarchy-server]', restore))
			throw error
		}
		if (moved) await rm(aside, {force: true})
		res.json({prefs})
	}))

	// ---- VM console ------------------------------------------------------------
	async function openConsoleSession(backend, credentials, userAgent, accessToken) {
		// From the sign-in that just happened (a 2FA code works only once); older servers sign in again.
		const {data: token, cookies} = await (accessToken
			? backend.mutation('user.browserSession', undefined, {userAgent, withCookies: true, token: accessToken}).catch(() => backend.mutation('user.login', credentials, {userAgent, withCookies: true}))
			: backend.mutation('user.login', credentials, {userAgent, withCookies: true}))
		const cookie = cookies.filter((c) => /BROWSER_SESSION/.test(c)).join('; ')
		if (typeof token !== 'string' || !cookie) return null
		// The same login also returns My Own Data Center's app-gateway session (OMARCHY_APP_SESSION). Touch
		// keeps it server-side so app windows open without My Own Data Center's separate app sign-in.
		const appCookie = cookies.find((c) => /^OMARCHY_APP_SESSION=/.test(c)) ?? null
		return {token, cookie, appCookie, renewedAt: Date.now(), appPassAt: Date.now()}
	}

	// The server-held browser-style session: dashboard token + browser cookie. omarchyd
	// requires it for WebSocket tickets and the file HTTP API; native sessions can't use those.
	async function browserAuth(sid) {
		const backend = getClient()
		const session = store.getSession(sid)
		if (!backend || !session) throw new BackendError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		if (!session.console) {
			throw new BackendError('Sign out and back in to use this', {code: 'CONSOLE_SESSION_REQUIRED', status: 409})
		}
		const auth = {token: session.console.token, cookie: session.console.cookie}
		// Browser sessions last 7 days from their last renewal; keep ours fresh.
		await renewBrowserSession(sid)
		return auth
	}
	// Renew the browser-style session when the last renewal was over a day ago. renewedAt moves only
	// when omarchyd accepted the renewal, so a refused or failed one is tried again, not recorded as done.
	const BROWSER_RENEW_MS = 24 * 60 * 60 * 1000
	async function renewBrowserSession(sid) {
		const backend = getClient()
		const session = store.getSession(sid)
		if (!backend || !session?.console || Date.now() - session.console.renewedAt <= BROWSER_RENEW_MS) return
		const {token, cookie} = session.console
		try {
			await backend.mutation('user.renewToken', undefined, {token, cookie})
		} catch {
			return
		}
		const current = store.getSession(sid)
		if (current?.console) await store.updateSession(sid, {console: {...current.console, renewedAt: Date.now()}})
	}
	// Called on every request, so the browser session stays alive for anyone who is still signed in,
	// not only for someone who opens Files or a console within its 7 days.
	const renewingBrowser = new Set()
	function keepBrowserSessionFresh(sid) {
		const s = store.getSession(sid)
		if (!s?.console || renewingBrowser.has(sid) || Date.now() - s.console.renewedAt <= BROWSER_RENEW_MS) return
		renewingBrowser.add(sid)
		renewBrowserSession(sid)
			.catch(() => {})
			.finally(() => renewingBrowser.delete(sid))
	}
	const lostBrowserSession = async (sid, error) => {
		if (error instanceof BackendError && error.code === 'UNAUTHORIZED') {
			await store.updateSession(sid, {console: null})
			return new BackendError('Sign out and back in to use this', {code: 'CONSOLE_SESSION_REQUIRED', status: 409})
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
	// Errors (signed out, server not answering) are thrown, not turned into "not the owner".
	async function sessionIsOwner(sid) {
		const me = await authedCall({sid}, 'user.get', 'query')
		return me?.role === 'owner'
	}

	// ---- Files: downloads, previews, thumbnails and uploads ---------------------
	// omarchyd serves file bytes over plain HTTP, authorised by the browser cookie plus
	// a session-wide URL token. We fetch both server-side and stream the bytes through.
	const urlTokens = new Map() // sid -> {token, at}
	const sessionStreamsByKey = new Map() // hashId(sid) -> Set<() => void>
	const registerSessionStream = (key, closeFn) => {
		let set = sessionStreamsByKey.get(key)
		if (!set) {
			set = new Set()
			sessionStreamsByKey.set(key, set)
		}
		set.add(closeFn)
		return () => {
			set.delete(closeFn)
			if (set.size === 0) sessionStreamsByKey.delete(key)
		}
	}
	const closeSessionStreams = (key) => {
		const set = sessionStreamsByKey.get(key)
		if (!set) return
		sessionStreamsByKey.delete(key)
		for (const fn of [...set]) {
			try {
				fn()
			} catch {}
		}
	}
	const closeAllSessionStreams = () => {
		for (const set of [...sessionStreamsByKey.values()]) {
			for (const fn of [...set]) {
				try {
					fn()
				} catch {}
			}
		}
		sessionStreamsByKey.clear()
	}
	// Cookie ids are not stored on the session (the file is keyed by their hash). Remember the
	// ones this process has seen so a removed session can drop its URL token.
	const sidByKey = new Map()
	const rememberSid = (sid) => {
		if (typeof sid === 'string' && sid) sidByKey.set(hashId(sid), sid)
	}
	const forgetUrlToken = (sid) => {
		if (typeof sid === 'string' && sid) {
			const key = hashId(sid)
			urlTokens.delete(sid)
			sidByKey.delete(key)
			closeSessionStreams(key)
		}
	}
	async function fileUrlToken(sid) {
		rememberSid(sid)
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
	// scope(req): {sid, paths} for a quick-transfer link (acting as the person who made it); by
	// default the signed-in browser and the paths it asked for.
	const fileGet = (kind, scope = null) => async (req, res) => {
		try {
			const scoped = scope ? scope(req) : null
			if (scope && !scoped) return res.status(404).json({error: {code: 'NOT_FOUND', message: 'This link has ended'}})
			const sid = scoped ? scoped.sid : req.sid
			if (!store.getSession(sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
			const auth = await browserAuth(sid)
			const token = await fileUrlToken(sid)
			const url = new URL(`${getClient().baseUrl}/api/files/${kind}`)
			if (kind === 'thumbnail') {
				if (!/^[\w.-]{1,200}$/.test(req.params.name)) return res.status(404).end()
				url.pathname += `/${req.params.name}`
			}
			for (const p of scoped ? scoped.paths : [req.query.path].flat()) if (typeof p === 'string') url.searchParams.append('path', p)
			url.searchParams.set('token', token)
			const upstream = await fetchImpl(url, {
				headers: {
					cookie: auth.cookie,
					...(req.headers.range ? {range: req.headers.range} : {}),
					...(typeof req.headers['if-range'] === 'string' ? {'if-range': req.headers['if-range']} : {}),
					...(kind === 'view' && typeof req.headers.accept === 'string' ? {accept: req.headers.accept.slice(0, 300)} : {}),
				},
				signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
			})
			if (upstream.status === 401) {
				forgetUrlToken(sid)
				await upstream.body?.cancel?.().catch(() => {})
				await store.updateSession(sid, {console: null})
				return res.status(409).json({error: {code: 'CONSOLE_SESSION_REQUIRED', message: 'Sign out and back in to use this'}})
			}
			res.status(upstream.status)
			for (const h of PASS_HEADERS) {
				const v = upstream.headers.get(h)
				if (v) res.setHeader(h, v)
			}
			res.setHeader('Cache-Control', kind === 'thumbnail' && upstream.ok ? 'private, max-age=3600' : 'private, no-store')
			res.setHeader('X-Content-Type-Options', 'nosniff')
			// Previews render inline but sandboxed, so a file can't script this app.
			if (kind === 'view') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
			// HEAD must not wait for the bytes. omarchyd only serves these routes as GET, so the
			// upstream method stays GET and the body is cancelled.
			if (req.method === 'HEAD') {
				await upstream.body?.cancel?.().catch(() => {})
				return res.end()
			}
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

	// Whole files, and big ones in pieces (upload-chunk: see omarchyd/files.mjs uploadChunk).
	const relayUpload = (kind, scope = null) => async (req, res) => {
		try {
			const scoped = scope ? scope(req) : null
			if (scope && !scoped) return res.status(404).json({error: {code: 'NOT_FOUND', message: 'This link has ended'}})
			if (scoped?.error) return res.status(400).json({error: {code: 'BAD_REQUEST', message: scoped.error}})
			const sid = scoped ? scoped.sid : req.sid
			if (!store.getSession(sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
			const path = scoped ? scoped.path : req.query.path
			if (typeof path !== 'string' || !path.startsWith('/')) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'path is required'}})
			// A quick-transfer upload never replaces anything: a name already there gets a new one.
			const collision = scoped ? 'keep-both' : ['error', 'keep-both', 'replace'].includes(req.query.collision) ? req.query.collision : 'keep-both'
			const auth = await browserAuth(sid)
			const url = new URL(`${getClient().baseUrl}/api/files/${kind}`)
			url.searchParams.set('path', path)
			url.searchParams.set('collision', collision)
			if (kind === 'upload-chunk') {
				const {id, offset, total} = req.query
				const ok = typeof id === 'string' && /^[a-f0-9]{16,64}$/.test(id) && [offset, total].every((v) => typeof v === 'string' && /^\d{1,16}$/.test(v))
				if (!ok) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Missing upload details'}})
				url.searchParams.set('id', id)
				url.searchParams.set('offset', offset)
				url.searchParams.set('total', total)
			}
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
			if (upstream.status === 401) {
				await store.updateSession(sid, {console: null})
				return res.status(409).json({error: {code: 'CONSOLE_SESSION_REQUIRED', message: 'Sign out and back in to use this'}})
			}
			if (!upstream.ok) {
				// A piece out of order says how much arrived, so the browser carries on from there.
				if (kind === 'upload-chunk' && upstream.status === 409 && body.error === '[wrong-offset]') return res.status(409).json({error: {code: 'WRONG_OFFSET', message: 'Resuming'}, received: body.received ?? 0})
				const message = upstream.status === 507 ? 'Not enough free space on your server' : upstream.status === 409 ? 'A file with that name already exists' : (body.error ?? `Upload failed (HTTP ${upstream.status})`)
				return res.status(upstream.status).json({error: {code: 'UPLOAD_FAILED', message}, ...(typeof body.received === 'number' ? {received: body.received} : {})})
			}
			if (kind === 'upload-chunk') return res.json({ok: true, received: body.received ?? 0, ...(body.path ? {path: body.path} : {})})
			res.json({ok: true, path: body.path ?? path})
		} catch (error) {
			sendError(res, error)
		}
	}
	api.post('/files/upload', relayUpload('upload'))

	// Quick transfer (Files › right-click › Share with a QR code / Upload from a phone).
	api.post('/transfer', catchSave(async (req, res) => {
		const session = requireSession(req, res)
		if (!session) return
		const {kind, path, name, size, theme, background} = req.body ?? {}
		if ((kind !== 'download' && kind !== 'upload') || typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || path.includes('\0'))
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Choose a file or a folder'}})
		// This server's own files only (Home and its drives), never the Trash or another computer.
		if (!/^\/(Home|External)(\/|$)/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Only files on this server can be shared this way'}})
		if (kind === 'upload') {
			// The folder must exist and take new files, as this person.
			const listing = await authedCall(req, 'files.list', 'query', {path, limit: 1}).catch(() => null)
			if (!listing || listing.type !== 'directory' || !listing.operations?.includes('writable'))
				return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Files can’t be added to this folder'}})
		}
		const shown = typeof name === 'string' && name.trim() ? name.trim().slice(0, 240) : path.split('/').pop() || 'File'
		const t = transfers.create({kind, path, name: shown, size: kind === 'download' ? Number(size) : null, sid: req.sid, accountId: session.accountId, theme, bg: background})
		res.json({path: `/t/${t.token}`, token: t.token, expiresAt: t.expiresAt})
	}))
	api.delete('/transfer/:token', (req, res) => {
		if (!requireSession(req, res)) return
		res.json({ok: transfers.revoke(req.params.token, req.sid)})
	})
	api.post('/files/upload-chunk', relayUpload('upload-chunk'))

	// Clip book bytes. Text and screenshots are larger than the JSON body limit, so they travel as
	// a raw body the same way an upload does. A 401 from omarchyd means the browser session is stale:
	// answer 409 so the page does not treat it as a sign-out.
	function clipFailure(status, body, fallback) {
		const message = typeof body?.error?.message === 'string' ? body.error.message : fallback
		const code = typeof body?.error?.data?.code === 'string' ? body.error.data.code : 'ERROR'
		return {status, message, code}
	}
	const clipPost = (kind) => async (req, res) => {
		try {
			if (!store.getSession(req.sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
			const auth = await browserAuth(req.sid)
			const url = new URL(`${getClient().baseUrl}/api/clips/${kind}`)
			if (kind === 'text') {
				url.searchParams.set('where', req.query.where === 'desktop' ? 'desktop' : 'terminal')
				if (req.query.cut === '1') url.searchParams.set('cut', '1')
			}
			if (typeof req.query.label === 'string') url.searchParams.set('label', req.query.label.slice(0, 80))
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
			let body = {}
			try {
				body = JSON.parse(text)
			} catch {
				body = {}
			}
			if (upstream.status === 401) {
				await store.updateSession(req.sid, {console: null})
				return res.status(409).json({error: {code: 'CONSOLE_SESSION_REQUIRED', message: 'Sign out and back in to use this'}})
			}
			if (!upstream.ok) {
				const fail = clipFailure(upstream.status, body, 'Couldn’t save that clip')
				return res.status(fail.status).json({error: {code: fail.code, message: fail.message}})
			}
			res.json(body)
		} catch (error) {
			sendError(res, error)
		}
	}
	api.post('/clips/text', clipPost('text'))
	api.post('/clips/image', clipPost('image'))
	api.get('/clips/item', async (req, res) => {
		try {
			if (!store.getSession(req.sid)) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
			const id = req.query.id
			if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'That clip isn’t in the book'}})
			const auth = await browserAuth(req.sid)
			const token = await fileUrlToken(req.sid)
			const url = new URL(`${getClient().baseUrl}/api/clips/item`)
			url.searchParams.set('token', token)
			url.searchParams.set('id', id)
			const upstream = await fetchImpl(url, {
				headers: {cookie: auth.cookie},
				signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
			})
			if (upstream.status === 401) {
				forgetUrlToken(req.sid)
				await upstream.body?.cancel?.().catch(() => {})
				await store.updateSession(req.sid, {console: null})
				return res.status(409).json({error: {code: 'CONSOLE_SESSION_REQUIRED', message: 'Sign out and back in to use this'}})
			}
			if (!upstream.ok) {
				const text = await upstream.text()
				let body = {}
				try {
					body = JSON.parse(text)
				} catch {
					body = {}
				}
				const fail = clipFailure(upstream.status, body, 'Couldn’t open that clip')
				return res.status(fail.status).json({error: {code: fail.code, message: fail.message}})
			}
			res.status(upstream.status)
			for (const h of ['content-type', 'content-length', 'content-disposition']) {
				const v = upstream.headers.get(h)
				if (v) res.setHeader(h, v)
			}
			res.setHeader('Cache-Control', 'private, no-store')
			res.setHeader('X-Content-Type-Options', 'nosniff')
			// HEAD must not wait for the bytes. omarchyd serves this route as GET, so the body is cancelled.
			if (req.method === 'HEAD') {
				await upstream.body?.cancel?.().catch(() => {})
				return res.end()
			}
			if (!upstream.body) return res.end()
			const {Readable} = await import('node:stream')
			const body = Readable.fromWeb(upstream.body)
			req.on('close', () => body.destroy())
			body.on('error', () => res.destroy())
			body.pipe(res)
		} catch (error) {
			sendError(res, error)
		}
	})

	// Desktop app windows: is this browser signed in to My Own Data Center's app gateway for this app?
	// My Own Data Center protects every app with its own sign-in (port 2000, /app-auth), whose page refuses
	// to be shown inside another site's frame. The resulting session cookie is per host, not per
	// port, so the browser also sends it to Touch. We only ask My Own Data Center whether it is valid for
	// the app (the same check My Own Data Center's own sign-in page makes) and answer yes/no. The cookie
	// itself is never stored, logged or returned, and this can't sign anyone in.
	const APP_COOKIES = ['OMARCHY_APP_SESSION', '__Host-OMARCHY_APP_SESSION_HTTPS']
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
			// omarchyd is reached over plain HTTP here, so it reads the plain-HTTP cookie name.
			const r = await fetch(url, {headers: {cookie: `OMARCHY_APP_SESSION=${encodeURIComponent(token)}`, accept: 'application/json'}, redirect: 'manual', signal: AbortSignal.timeout(8000)})
			await r.arrayBuffer().catch(() => {})
			res.json({state: r.status === 200 ? 'ok' : r.status === 401 ? 'signin' : r.status === 403 ? 'not-shared' : 'unknown'})
		} catch {
			res.json({state: 'unknown'})
		}
	})

	// Desktop: can each app be shown inside a window? Many apps (Forgejo, Nextcloud, Home
	// Assistant…) forbid being embedded in another site (X-Frame-Options / CSP frame-ancestors),
	// which browsers show as "refused to connect". We load each app's start page once, the way
	// the browser would (through My Own Data Center's app gateway, with the browser's own app session,
	// which the gateway strips before the app sees it), and read only those headers.
	//   window: can be shown in a window · tab: must open in a browser tab
	//   signin: My Own Data Center wants this browser to sign in first · unknown: couldn't tell
	const appFrameCache = new Map() // `${appId}:${signedIn}` -> {verdict, at}
	async function frameVerdict(app, serverHost, cookieHeader) {
		if (!app?.port) return 'unknown'
		if (app.requiresHttps) return 'tab'
		const origin = `http://${bracketHost(serverHost)}:${app.port}`
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
				// Sent elsewhere (My Own Data Center's sign-in on port 2000, or an old login page): sign in first.
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
	// on a port of its own and swaps the app's "nobody may embed me" header for "only My Own Data Center
	// Touch may embed me". Everything else passes through untouched, including My Own Data Center's app
	// gateway, so My Own Data Center still checks its own sign-in on every request. On top of that the
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
				// Touch's cookies never reach the app; Touch's own My Own Data Center app session wins.
				return c && name !== COOKIE && name !== APP_COOKIE && !(held && name === 'OMARCHY_APP_SESSION')
			})
		if (held) rest.push(held)
		if (rest.length) h.cookie = rest.join('; ')
		else delete h.cookie
		return h
	}
	// "Only Touch may embed me": drop X-Frame-Options and any frame-ancestors, add ours.
	// A comma joins two policies. Quotes can contain commas, so split policies first, then directives.
	const splitPolicies = (value) => {
		const out = []
		let cur = ''
		let quote = ''
		for (const ch of String(value)) {
			if (quote) {
				if (ch === quote) quote = ''
				cur += ch
				continue
			}
			if (ch === '"' || ch === "'") {
				quote = ch
				cur += ch
				continue
			}
			if (ch === ',') {
				out.push(cur)
				cur = ''
				continue
			}
			cur += ch
		}
		out.push(cur)
		return out
	}
	const frameHeaders = (headers, ancestors) => {
		delete headers['x-frame-options']
		const allow = `frame-ancestors 'self' ${[...ancestors].join(' ')}`.trim()
		const policies = []
		for (const value of [].concat(headers['content-security-policy'] ?? [])) {
			for (const policy of splitPolicies(value)) {
				const kept = policy
					.split(';')
					.map((d) => d.trim())
					.filter((d) => d && !/^frame-ancestors\b/i.test(d))
				if (kept.length) policies.push(`${kept.join('; ')}; ${allow}`)
			}
		}
		headers['content-security-policy'] = policies.length === 0 ? allow : policies.length === 1 ? policies[0] : policies
	}
	// The address a browser sees for this request (Cloudflare tunnels arrive as https).
	const publicOrigin = (req) => (/^[a-z0-9.\-:[\]]{1,260}$/i.test(req.headers.host ?? '') ? `${req.protocol}://${req.headers.host}` : null)

	// App subdomains for remote access (Cloudflare tunnel etc.): TOUCH_APP_HOSTS="{app}-touch.example.com"
	// routes e.g. forgejo-touch.example.com to Forgejo through the relay, on Touch's own port.
	const appHostPattern = (() => {
		let p = null
		try {
			p = normalizeAppHosts(store.getConfig().appHosts)
		} catch {
			return null
		}
		if (!p) return null
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

	function startRelay(app, serverHost) {
		const relay = {appId: app.id, port: 0, targetPort: app.port, ancestors: new Set(), server: null}
		const upstream = (req, sid) => ({host: serverHost, port: relay.targetPort, method: req.method, path: req.url, headers: relayHeaders(req, sid)})
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
					return res.end('This link has expired. Open the app again from My Own Data Center.')
				}
				const id = randomBytes(32).toString('base64url')
				const nowMs = Date.now()
				for (const [key, entry] of appSessions) if (entry.exp <= nowMs) appSessions.delete(key)
				appSessions.set(id, {sid: t.sid, appId: app.id, exp: nowMs + 12 * 60 * 60 * 1000})
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
				return res.end('Sign in to My Own Data Center first.')
			}
			const up = http.request(upstream(req, sid), (ur) => {
				const headers = {...ur.headers}
				const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '')
				if (headers.location) {
					try {
						const to = new URL(headers.location, `http://${req.headers.host}`)
						if (to.pathname.startsWith('/app-auth') && to.port !== String(relay.port)) {
							// My Own Data Center wants a fresh sign-in; its page can't load in a window.
							ur.resume()
							res.writeHead(401, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
							return res.end('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#888;text-align:center;padding:24px">Your app session ended.<br>Sign out and back in, then reopen this app.</body>')
						}
						if (to.port === String(relay.targetPort) && (to.hostname === hostname || isLoopback(to.hostname) || to.hostname === serverHost)) {
							// Back to the address the browser used: its scheme and its host, port and all (an
							// app address behind a TLS proxy has no port, and \`to.host = …\` would keep the old one).
							const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http')
							headers.location = `${proto === 'https' ? 'https' : 'http'}://${req.headers.host}${to.pathname}${to.search}${to.hash}`
						}
					} catch {
						/* leave it */
					}
				}
				frameHeaders(headers, relay.ancestors)
				res.writeHead(ur.statusCode ?? 502, ur.statusMessage, headers)
				ur.pipe(res)
			})
			linkProxy(req, res, up)
			up.on('error', () => {
				if (res.headersSent) return
				res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'})
				res.end('The app isn’t answering right now.')
			})
			req.pipe(up)
		}
		relay.upgrade = (req, socket, head) => {
			const sid = relaySid(req, app.id)
			if (!sid) return socket.destroy()
			const up = http.request(upstream(req, sid))
			// A browser that goes away while the app is still answering must not raise an unhandled 'error'.
			socket.on('error', () => up.destroy())
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
		// https:// too, so an app window works inside the https:// web app (see tls.mjs).
		relay.server = tls ? dualProtocolServer(server, tls.get) : server
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
			res.status(401).type('text/plain').send('Open this app from My Own Data Center.')
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

	async function relayFor(app, serverHost, ancestor) {
		let relay = relays.get(app.id)
		if (relay && relay.targetPort !== app.port) {
			relay.server.close()
			relays.delete(app.id)
			relay = null
		}
		if (!relay) {
			relay = startRelay(app, serverHost)
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
	// Opening an app is when we learn which apps still exist. Relays for the rest are closed
	// here, or their ports stay taken until this process restarts (only 100 relay ports exist).
	async function releaseUnusedRelays(apps) {
		const live = new Set(apps.map((a) => a.id))
		const drop = async (map) => {
			for (const [id, relay] of [...map]) {
				if (live.has(id)) continue
				await new Promise((resolve) => relay.server.close(() => resolve()))
				map.delete(id)
			}
		}
		await drop(relays)
		await drop(relaysByApp)
	}
	app.closeRelays = () => {
		for (const r of relays.values()) r.server.close()
		relays.clear()
	}

	// How each app opens on the desktop. With Touch's own My Own Data Center app session (every sign-in
	// since 0.12), every app is relayed, so it opens in a window with no extra sign-in. Without it,
	// only apps that forbid embedding are relayed and the browser's own My Own Data Center sign-in applies.
	//   results[id]: window | tab | signin | unknown
	//   relay[id]:   true when the app opens through a relay (ask /api/app-open for its address)
	// How a browser tab reaches an app from the page that asked:
	//   relay   app addresses are set up (TOUCH_APP_HOSTS): ask /api/app-open for the app's own address
	//   direct  the page reached this server on its own port, so the apps' ports on that host work too
	//   none    neither (a reverse proxy on 443 with no app addresses): the app ports aren't reachable
	// Behind a proxy the browser's Host has the proxy's port (or none), not the one this server listens on.
	const appAccess = (req) => {
		if (relayMode(req) === 'host') return 'relay'
		const hostHeader = String(req.headers.host ?? '')
		const m = /:(\d+)$/.exec(hostHeader.replace(/^\[[^\]]*\]/, (b) => b.replace(/:/g, '')))
		const asked = m ? Number(m[1]) : req.secure ? 443 : 80
		return asked === req.socket?.localPort ? 'direct' : 'none'
	}
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
			// Only My Own Data Center's own app-session cookies are sent (current and older My Own Data Center).
			const cookieHeader =
				held ??
				['OMARCHY_APP_SESSION', 'OMARCHY_PROXY_TOKEN']
					.filter((n) => typeof cookies[n] === 'string' && cookies[n].length < 4096)
					.map((n) => `${n}=${encodeURIComponent(cookies[n])}`)
					.join('; ')
			const serverHost = new URL(getClient().baseUrl).hostname
			const results = {}
			const relay = {}
			await Promise.all(
				ids.map(async (id) => {
					const app = apps.find((a) => a.id === id)
					if (!app?.port) return void (results[id] = 'unknown')
					if (app.requiresHttps) return void (results[id] = 'tab')
					// On this network My Own Data Center's own app gateway lets its apps be shown inside this
					// page, and hands each browser its app session itself: a plain window, no relay port.
					if (mode === 'port') return void (results[id] = 'window')
					if (sso && mode) {
						relay[id] = true
						return void (results[id] = 'window')
					}
					const key = `${id}:${app.port}:${cookieHeader ? 1 : 0}`
					const hit = appFrameCache.get(key)
					const fresh = hit && Date.now() - hit.at < 10 * 60 * 1000
					let verdict = fresh ? hit.verdict : await frameVerdict(app, serverHost, cookieHeader)
					// A new answer starts a new 10 minutes.
					if (!fresh && (verdict === 'window' || verdict === 'tab' || verdict === 'blocked')) appFrameCache.set(key, {verdict, at: Date.now()})
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
	// A browser opened an app before it had an app session: hand one over through the app's own
	// port (cookies belong to the host, so this covers every app on this server from then on).
	api.get('/app-enter', async (req, res) => {
		const id = String(req.query.app ?? '')
		const r = typeof req.query.r === 'string' && req.query.r.startsWith('/') && !req.query.r.startsWith('//') ? req.query.r : '/'
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return res.status(400).type('text/plain').send('Bad app')
		if (!store.getSession(req.sid)) return res.redirect(302, '/')
		try {
			const {ticket, port} = await authedCall(req, 'apps.accessTicket', 'mutation', {appId: id, view: req.query.view === '1'})
			const h = bracketHost(req.hostname)
			res.redirect(302, `${req.protocol}://${h}:${port}/__omarchy/enter?t=${encodeURIComponent(ticket)}&r=${encodeURIComponent(r)}`)
		} catch (error) {
			if (error instanceof BackendError && error.code === 'UNAUTHORIZED') return res.redirect(302, '/')
			res.status(error instanceof BackendError ? 404 : 500).type('text/plain').send(error instanceof BackendError ? error.message : 'Couldn’t open that app')
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
			await releaseUnusedRelays(apps)
			const app = apps.find((a) => a.id === id)
			if (!app?.port) return res.status(404).json({error: {code: 'NOT_FOUND', message: 'That app has no web interface'}})
			const mode = relayMode(req)
			const path = typeof app.path === 'string' && app.path.startsWith('/') ? app.path : '/'
			const ancestor = publicOrigin(req)
			const serverHost = new URL(getClient().baseUrl).hostname
			if (mode === 'host') {
				const host = appHostPattern.make(app.id)
				let relay = relaysByApp.get(app.id)
				if (!relay || relay.targetPort !== app.port) {
					relay = startRelay(app, serverHost)
					relaysByApp.set(app.id, relay)
				}
				if (ancestor) relay.ancestors.add(ancestor)
				const t = randomBytes(32).toString('base64url')
				appTickets.set(t, {sid: req.sid, appId: app.id, exp: Date.now() + 2 * 60 * 1000})
				for (const [k, v] of appTickets) if (v.exp < Date.now()) appTickets.delete(k)
				// address: the app's own address, to copy or bookmark (the url above is a one-time sign-in).
				return res.json({url: `${req.protocol}://${host}/__touch/enter?t=${t}&r=${encodeURIComponent(path)}`, ping: `${req.protocol}://${host}/__touch/ping.gif`, address: `${req.protocol}://${host}${path}`})
			}
			if (mode === 'port') {
				const port = await relayFor(app, serverHost, ancestor)
				if (!port) return res.status(503).json({error: {code: 'UNAVAILABLE', message: 'No free port for the app relay'}})
				const h = bracketHost(req.hostname)
				return res.json({url: `${req.protocol}://${h}:${port}${path}`, ping: `${req.protocol}://${h}:${port}/__touch/ping.gif`, address: `${req.protocol}://${h}:${port}${path}`})
			}
			res.status(409).json({error: {code: 'NEEDS_APP_HOSTS', message: 'Opening apps remotely needs app addresses (see the README)'}})
		} catch (error) {
			sendError(res, error)
		}
	})

	// Asked before the socket opens so the app can show a clear reason when it can't.
	api.get('/console/check', async (req, res) => {
		try {
			const terminal = req.query.target === 'terminal'
			const agent = /^agent-([0-9a-f]{12})$/.exec(String(req.query.machineId ?? ''))
			const ownDesktop = req.query.machineId === 'desktop'
			if ((terminal || agent || ownDesktop) && !(await sessionIsOwner(req.sid))) {
				throw new BackendError(terminal ? 'Only the server’s owner can open a shell' : ownDesktop ? 'Only the server’s owner can open this server’s desktop' : 'Only the server’s owner can manage the local swarm', {code: 'FORBIDDEN', status: 403})
			}
			await consoleTicket(req.sid, terminal ? 'terminal' : 'machines') // single-use, 30s; discarded
			// The server's own desktop: make sure its screen sharing is running (starts it if not),
			// or say plainly why it can't be.
			if (req.query.machineId === 'desktop') await authedCall(req, 'system.desktopShare', 'mutation')
			// A computer in the local swarm: is its desktop there to show (and allowed)?
			if (agent) await authedCall(req, 'swarm.desktopCheck', 'query', {id: agent[1]})
			res.json({ok: true})
		} catch (error) {
			sendError(res, error)
		}
	})

	// WebSocket bridges: phone <-> this server <-> omarchyd.
	//   /api/console?machineId=…            -> /machines/console (raw VNC, binary)
	//   /api/terminal?appId=…&cols=…&rows=…[&fresh=1] -> /terminal (your shell, which keeps running when
	//   closed; appId = a shell inside that app; fresh = end it and start a new one)
	// On a restart: tell every terminal, desktop and app connection the server is going (1001, so pages
	// reconnect), and stop the app relays.
	const consoles = new Set()
	app.closeAll = () => {
		for (const wss of consoles) for (const c of wss.clients) c.close(1001, 'server restarting')
		for (const r of relays.values()) r.server?.close?.()
		for (const r of relays.values()) r.server?.destroyConnections?.()
	}
	app.attachConsole = (server) => {
		const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false})
		consoles.add(wss)
		server.on('upgrade', async (req, socket, head) => {
			// A browser that resets the connection while we are still checking its session or asking omarchyd
			// would otherwise raise an unhandled 'error' on its socket and end this process.
			socket.on('error', () => {})
			if (app.relayUpgrade(req, socket, head)) return
			const refuse = (status) => {
				if (socket.destroyed) return
				socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
				socket.destroy()
			}
			// Until the upgrade completes nothing else watches the browser's socket: if the tab goes away
			// first, drop the connection to omarchyd too. The returned function stops watching.
			const dropWithBrowser = (upstream) => {
				const gone = () => upstream.terminate()
				socket.once('close', gone)
				socket.once('error', gone)
				if (socket.destroyed) gone()
				return () => {
					socket.off('close', gone)
					socket.off('error', gone)
				}
			}
			try {
				const url = new URL(req.url, 'http://x')
				// A connector on another computer: no browser session; it signs in with its own key,
				// which omarchyd checks. Passed straight through.
				if (url.pathname === '/connector/ws') {
					const target = new URL(getClient().baseUrl)
					target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
					target.pathname = '/connector/ws'
					const upstream = new WebSocket(target, {headers: {authorization: String(req.headers.authorization ?? '')}, handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024, autoPong: false})
					upstream.once('unexpected-response', (_q, r) => refuse(`${r.statusCode === 401 ? '401 Unauthorized' : '502 Bad Gateway'}`))
					upstream.once('error', () => refuse('502 Bad Gateway'))
					const stopWatching = dropWithBrowser(upstream)
					upstream.once('open', () => {
						upstream.removeAllListeners('error')
						wss.handleUpgrade(req, socket, head, (client) => {
							stopWatching()
							upstream.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, {binary: isBinary}))
							client.on('message', (data, isBinary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, {binary: isBinary}))
							upstream.on('close', (code) => {
								if (client.readyState !== WebSocket.OPEN) return
								if (code === 1006) client.terminate()
								else client.close(1000)
							})
							client.on('close', () => upstream.readyState === WebSocket.OPEN && upstream.close(1000))
							upstream.on('error', () => client.terminate())
							client.on('error', () => upstream.terminate())
							// Keep it open through idle stretches (pings and pongs pass between omarchyd and the connector).
							upstream.on('ping', (d) => client.readyState === WebSocket.OPEN && client.ping(d))
							client.on('pong', (d) => upstream.readyState === WebSocket.OPEN && upstream.pong(d))
						})
					})
					return
				}
				const route = {'/api/console': 'machines', '/api/terminal': 'terminal', '/api/hyprland/stream': 'hyprland'}[url.pathname]
				if (!route) return refuse('404 Not Found')
				// Browsers always send Origin on WebSocket handshakes: refuse other sites and scheme mismatches.
				const origin = req.headers.origin
				let originOk = false
				if (origin) {
					try {
						const ou = new URL(origin)
						const expectedProto = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:'
						originOk = ou.host === req.headers.host && ou.protocol === expectedProto
					} catch {}
				}
				if (!originOk) return refuse('403 Forbidden')
				const sid = parseCookies(req.headers.cookie)[COOKIE]
				if (!store.getSession(sid)) return refuse('401 Unauthorized')
				const sidKey = hashId(sid)
				rememberSid(sid)
				const target = new URL(getClient().baseUrl)
				target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
				let params
				if (route === 'machines') {
					const machineId = url.searchParams.get('machineId') ?? ''
					if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) return refuse('400 Bad Request')
					target.pathname = '/machines/console'
					params = {machineId, sessionId: randomUUID()}
				} else if (route === 'hyprland') {
					const mode = url.searchParams.get('mode') === 'window' ? 'window' : 'output'
					const address = mode === 'window' ? (url.searchParams.get('address') ?? '') : ''
					if (mode === 'window' && !/^0x[0-9a-f]{4,16}$/i.test(address)) return refuse('400 Bad Request')
					const output = mode === 'output' ? (url.searchParams.get('output') ?? '') : ''
					if (output && !/^[A-Za-z0-9_.-]{1,32}$/.test(output)) return refuse('400 Bad Request')
					const fps = Math.max(5, Math.min(120, Math.round(Number(url.searchParams.get('fps')) || 60)))
					const bitrate = Math.max(1000, Math.min(150000, Math.round(Number(url.searchParams.get('bitrate')) || 22000)))
					const audio = url.searchParams.get('audio') === '1' ? '1' : '0'
					const audioCodec = url.searchParams.get('audioCodec') === 'opus' ? 'opus' : 'pcm'
					const rawCodec = url.searchParams.get('codec') ?? 'h264'
					const codec = rawCodec === 'hevc444' || rawCodec === 'hevc10' || rawCodec === 'hevc' ? rawCodec : 'h264'
					const rawQ = Number(url.searchParams.get('quality') ?? 0)
					const rawComp = Number(url.searchParams.get('compression') ?? 0)
					target.pathname = '/hyprland/stream'
					params = {
						mode,
						...(address ? {address} : {}),
						...(output ? {output} : {}),
						fps: String(fps),
						bitrate: String(bitrate),
						audio,
						audioCodec,
						codec,
						...(rawQ >= 10 && rawQ <= 34 ? {quality: String(Math.round(rawQ))} : {}),
						...(rawComp >= 1 && rawComp <= 7 ? {compression: String(Math.round(rawComp))} : {}),
					}
				} else {
					const appId = url.searchParams.get('appId') ?? ''
					const agentId = url.searchParams.get('agentId') ?? ''
					const cols = Number(url.searchParams.get('cols'))
					const rows = Number(url.searchParams.get('rows'))
					if (appId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(appId)) return refuse('400 Bad Request')
					if (agentId && !/^[0-9a-f]{12}$/.test(agentId)) return refuse('400 Bad Request')
					// One of this server's LXC containers: its console or a shell in it. Without this the
					// request reached omarchyd as a plain terminal and opened the server's own shell.
					const containerId = url.searchParams.get('containerId') ?? ''
					const containerMode = url.searchParams.get('containerMode') === 'shell' ? 'shell' : 'console'
					if (containerId && !/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(containerId)) return refuse('400 Bad Request')
					if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 4 || rows > 300) return refuse('400 Bad Request')
					target.pathname = '/terminal'
					const session = url.searchParams.get('session') ?? ''
					if (session && !/^[A-Za-z0-9._-]{1,40}$/.test(session)) return refuse('400 Bad Request')
					params = {...(appId ? {appId} : {}), ...(agentId ? {agentId} : {}), ...(containerId ? {containerId, containerMode} : {}), ...(session ? {session} : {}), cols: String(cols), rows: String(rows), ...(url.searchParams.get('fresh') === '1' ? {fresh: '1'} : {})}
				}
				const needsOwner = route === 'terminal' || route === 'hyprland' || params.machineId === 'desktop' || /^agent-[0-9a-f]{12}$/.test(params.machineId ?? '')
				if (needsOwner) {
					let owner
					try {
						owner = await sessionIsOwner(sid)
					} catch (error) {
						return refuse(error?.code === 'UNAUTHORIZED' ? '401 Unauthorized' : '502 Bad Gateway')
					}
					if (!owner) return refuse('403 Forbidden')
				}
				const ticket = await consoleTicket(sid, route)
				target.search = new URLSearchParams({...params, ticket}).toString()
				const upstream = new WebSocket(target, route === 'machines' ? ['binary'] : [], {handshakeTimeout: 10_000, perMessageDeflate: false})
				upstream.once('unexpected-response', (_q, r) => {
					r.resume()
					upstream.removeAllListeners('error')
					refuse(r.statusCode === 403 ? '403 Forbidden' : r.statusCode === 401 ? '401 Unauthorized' : '502 Bad Gateway')
				})
				upstream.once('error', () => refuse('502 Bad Gateway'))
				const stopWatching = dropWithBrowser(upstream)
				const unregisterPending = registerSessionStream(sidKey, () => {
					try {
						upstream.terminate()
					} catch {}
					refuse('401 Unauthorized')
				})
				upstream.once('close', unregisterPending)
				upstream.once('error', unregisterPending)
				upstream.once('open', () => {
					unregisterPending()
					upstream.removeAllListeners('error')
					if (!store.getSession(sid)) {
						upstream.close(1008, 'Signed out')
						return refuse('401 Unauthorized')
					}
					wss.handleUpgrade(req, socket, head, (client) => {
						stopWatching()
						try {
							socket.setNoDelay?.(true)
							upstream._socket?.setNoDelay?.(true)
						} catch {}
						let proxyKeyTimer = null
						let unregisterActive = () => {}
						// Remote screens: slow the source down while this browser catches up (see backpressure.mjs).
						const behind = viewerBackpressure(client, upstream, () => closeBoth(1011, 'The viewer fell behind'))
						const closeBoth = (code, reason) => {
							behind.stop()
							unregisterActive()
							if (proxyKeyTimer) {
								clearTimeout(proxyKeyTimer)
								proxyKeyTimer = null
							}
							const safe = typeof code === 'number' && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000
							for (const ws of [client, upstream]) if (ws.readyState === WebSocket.OPEN) ws.close(safe, reason)
						}
						unregisterActive = registerSessionStream(sidKey, () => closeBoth(1008, 'Signed out'))
						const hyprBitrateKbps = route === 'hyprland' ? Math.max(1000, Math.min(150000, Number(params.bitrate) || 22000)) : 22000
						let hyprDeltaDrop = Math.max(384 * 1024, Math.min(4 * 1024 * 1024, Math.round(((hyprBitrateKbps * 1000) / 8) * 0.25)))
						let hyprCloseCap = Math.max(4 * 1024 * 1024, hyprDeltaDrop * 6)
						let hyprKeyDrain = Math.max(64 * 1024, Math.round(hyprDeltaDrop / 4))
						let dropUntilKey = false
						let pendingKeyReq = false
						let lastKeyReqAt = 0
						const scheduleProxyKeyReq = () => {
							if (!pendingKeyReq || client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return
							const nowMs = Date.now()
							const cooldownLeft = Math.max(0, 1500 - (nowMs - lastKeyReqAt))
							if (client.bufferedAmount <= hyprKeyDrain && cooldownLeft === 0) {
								lastKeyReqAt = nowMs
								upstream.send('{"type":"keyframe"}')
								if (proxyKeyTimer) {
									clearTimeout(proxyKeyTimer)
									proxyKeyTimer = null
								}
								proxyKeyTimer = setTimeout(() => {
									proxyKeyTimer = null
									if (dropUntilKey && pendingKeyReq) scheduleProxyKeyReq()
								}, 1500)
								proxyKeyTimer.unref?.()
								return
							}
							if (!proxyKeyTimer) {
								proxyKeyTimer = setTimeout(() => {
									proxyKeyTimer = null
									scheduleProxyKeyReq()
								}, cooldownLeft > 0 ? cooldownLeft : 120)
								proxyKeyTimer.unref?.()
							}
						}
						upstream.on('message', (data, isBinary) => {
							if (client.readyState !== WebSocket.OPEN) return
							if (route === 'hyprland') {
								if (!isBinary) {
									const s = String(data ?? '')
									if (s.length <= 512 && (s.includes('"reconfig_applied"') || s.includes('"meta"'))) {
										try {
											const parsed = JSON.parse(s)
											if ((parsed?.type === 'reconfig_applied' || parsed?.type === 'meta') && typeof parsed.bitrate === 'number' && Number.isFinite(parsed.bitrate)) {
												const kbps = Math.max(1000, Math.min(150000, Math.round(parsed.bitrate)))
												hyprDeltaDrop = Math.max(384 * 1024, Math.min(4 * 1024 * 1024, Math.round(((kbps * 1000) / 8) * 0.25)))
												hyprCloseCap = Math.max(4 * 1024 * 1024, hyprDeltaDrop * 6)
												hyprKeyDrain = Math.max(64 * 1024, Math.round(hyprDeltaDrop / 4))
											}
										} catch {}
									}
								}
								const buf = isBinary && Buffer.isBuffer(data) ? data : null
								const isVideoDelta = buf && buf.length > 9 && buf[0] === 0
								const isVideoKey = buf && buf.length > 9 && buf[0] === 1
								if (client.bufferedAmount > hyprCloseCap) {
									closeBoth(1011, 'The viewer fell behind')
									return
								}
								// Bitrate-proportional delta-drop ceiling (~250 ms) prevents WAN bufferbloat while allowing 100+ Mbps LAN near-lossless frames
								if (client.bufferedAmount > hyprDeltaDrop && isVideoDelta) {
									dropUntilKey = true
									pendingKeyReq = true
									scheduleProxyKeyReq()
									return
								}
								// Only request recovery IDR once TCP send queue drains below hyprKeyDrain so keyframes do not pile onto congestion
								if (pendingKeyReq && client.bufferedAmount <= hyprKeyDrain) {
									scheduleProxyKeyReq()
								}
								if (dropUntilKey && isVideoDelta) return
								if (isVideoKey) {
									dropUntilKey = false
									pendingKeyReq = false
									if (proxyKeyTimer) {
										clearTimeout(proxyKeyTimer)
										proxyKeyTimer = null
									}
								}
								client.send(data, {binary: isBinary})
								return
							}
							if (route === 'machines') {
								// A remote screen's big burst (the whole picture after signing in) waits for the browser
								// instead of cutting it off, which made it reconnect and get cut off again in a loop.
								client.send(data, {binary: isBinary})
								behind.check()
								return
							}
							// Shells: same 1 MiB cap as before (the terminal replays what it missed on reconnect).
							if (client.bufferedAmount > 1024 * 1024) {
								closeBoth(1011, 'The viewer fell behind')
								return
							}
							client.send(data, {binary: isBinary})
						})
						client.on('message', (data, isBinary) => {
							if (upstream.readyState === WebSocket.OPEN) upstream.send(data, {binary: isBinary})
						})
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
	// ---- Settings › Signed-in devices and Factory reset ----------------------------------------
	// This web server holds each signed-in browser's session, so it lists and ends them itself.
	async function endStoredSession(key, session) {
		const backend = getClient()
		if (session.console) await backend?.mutation('user.logout', undefined, {token: session.console.token, cookie: session.console.cookie}).catch(() => {})
		if (session.mode === 'native' && session.deviceToken) {
			const fresh = await backend?.mutation('user.refreshNativeAccess', {deviceToken: session.deviceToken}).catch(() => null)
			if (fresh?.accessToken) await backend.mutation('user.logout', undefined, {token: fresh.accessToken}).catch(() => {})
		}
		forgetUrlToken(sidByKey.get(key))
		closeSessionStreams(key)
		await store.deleteSessionByKey(key)
	}
	// Signing a device out ends every app pass this person holds (passes have one generation per
	// person). Every device of theirs that is still signed in here gets the new one, not just this one.
	async function renewAppPass(req, res) {
		const cookie = await authedCall(req, 'user.revokeAppPasses', 'mutation').catch(() => null)
		const session = store.getSession(req.sid)
		if (typeof cookie !== 'string' || !session?.console) return
		const appCookie = cookie.split(';')[0]
		for (const {key, session: s} of store.sessionEntries()) {
			if (s.accountId !== session.accountId || !s.console) continue
			await store.updateSessionByKey(key, {console: {...s.console, appCookie, appPassAt: Date.now()}})
		}
		await store.updateSession(req.sid, {console: {...store.getSession(req.sid).console, appCookie, appPassAt: Date.now()}})
		shareAppSession(req, res, store.getSession(req.sid))
	}
	// App passes last 30 days; this sign-in lasts a year. Swap in a new pass once a week while it's used.
	const APP_PASS_RENEW_MS = 7 * 86_400_000
	const renewingPass = new Set()
	function keepAppPassFresh(sid) {
		const s = store.getSession(sid)
		if (!s?.console?.appCookie || renewingPass.has(sid) || Date.now() - (s.console.appPassAt ?? 0) < APP_PASS_RENEW_MS) return
		renewingPass.add(sid)
		;(async () => {
			const auth = await browserAuth(sid)
			const cookie = await getClient()?.mutation('user.appPass', undefined, auth)
			const cur = store.getSession(sid)
			if (typeof cookie === 'string' && cur?.console) await store.updateSession(sid, {console: {...cur.console, appCookie: cookie.split(';')[0], appPassAt: Date.now()}})
		})()
			.catch(() => {})
			.finally(() => renewingPass.delete(sid))
	}
	async function endOtherStoredSessions(req, res) {
		const {myKey, list} = mine(req)
		for (const {key, session} of list) if (key !== myKey) await endStoredSession(key, session)
		await renewAppPass(req, res)
		return true
	}
	const mine = (req) => {
		const me = store.getSession(req.sid)
		if (!me) throw new BackendError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		const myKey = hashId(req.sid)
		return {me, myKey, list: store.sessionEntries().filter(({session}) => session.accountId === me.accountId)}
	}
	const LOCAL = {
		'user.listSessions': async (req) => {
			const {myKey, list} = mine(req)
			return list
				.map(({key, session}) => ({
					id: key.slice(0, 32),
					createdAt: session.createdAt ?? 0,
					lastSeenAt: session.lastSeenAt ?? session.createdAt ?? 0,
					current: key === myKey,
					client: {type: 'browser', userAgent: session.userAgent ?? ''},
				}))
				.sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
		},
		'user.revokeSession': async (req, res, input) => {
			const {myKey, list} = mine(req)
			const target = list.find(({key}) => key.slice(0, 32) === String(input?.sessionId ?? ''))
			if (!target) throw new BackendError('That device is already signed out', {code: 'NOT_FOUND', status: 404})
			if (target.key === myKey) throw new BackendError('Use Sign out to sign this device out', {code: 'BAD_REQUEST', status: 400})
			await endStoredSession(target.key, target.session)
			await renewAppPass(req, res)
			return true
		},
		'user.changePassword': async (req, res, input) => {
			await authedCall(req, 'user.changePassword', 'mutation', input)
			return endOtherStoredSessions(req, res)
		},
		'user.revokeOtherSessions': async (req, res) => endOtherStoredSessions(req, res),
		// The reset itself happens in omarchyd; every sign-in here ends with it.
		// Appearance saved on this server (prefs, desktops, uploaded backgrounds) goes with it.
		'system.factoryReset': async (req, res, input) => {
			await authedCall(req, 'system.factoryReset', 'mutation', input)
			await store.setConfig((current) => ({...current, prefs: undefined, desktops: undefined}))
			await rm(join(store.dataDir, 'backgrounds'), {recursive: true, force: true})
			urlTokens.clear()
			sidByKey.clear()
			closeAllSessionStreams()
			await store.clearSessions()
			setCookie(res, '', 0)
			res.append('Set-Cookie', 'OMARCHY_APP_SESSION=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
			return true
		},
	}

	const proxy = async (req, res) => {
		const path = req.params.path
		if (!Object.hasOwn(ALLOWED, path)) return res.status(404).json({error: {code: 'NOT_FOUND', message: `${path} is not available in My Own Data Center`}})
		const kind = ALLOWED[path]
		if ((kind === 'query') !== (req.method === 'GET')) {
			return res.set('Allow', kind === 'query' ? 'GET' : 'POST').status(405).json({error: {code: 'METHOD_NOT_SUPPORTED', message: 'Wrong method'}})
		}
		let input
		try {
			input = kind === 'query' ? (req.query.input === undefined ? undefined : JSON.parse(String(req.query.input))) : req.body?.input
		} catch {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Malformed input'}})
		}
		try {
			if (Object.hasOwn(LOCAL, path)) return res.json({data: (await LOCAL[path](req, res, input)) ?? null})
			const data = await authedCall(req, path, kind, input)
			res.json({data: data ?? null})
		} catch (error) {
			if (error instanceof BackendError && error.code === 'UNAUTHORIZED' && !store.getSession(req.sid)) setCookie(res, '', 0)
			sendError(res, error)
		}
	}
	api.get('/rpc/:path', proxy)
	api.post('/rpc/:path', proxy)

	// SSE from omarchyd. Pipe the body; do not buffer the model reply.
	api.post('/assistant/stream', async (req, res) => {
		const backend = getClient()
		if (!backend) return res.status(409).json({error: {code: 'NOT_CONFIGURED', message: 'The My Own Data Center backend (omarchyd) isn’t set up yet'}})
		const session = store.getSession(req.sid)
		if (!session) return res.status(401).json({error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
		const ac = new AbortController()
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			ac.abort()
		}, 20 * 60 * 1000)
		timer.unref?.()
		res.on('close', () => {
			if (!res.writableEnded) ac.abort()
		})
		try {
			const token = await accessTokenFor(req.sid, session)
			const upstream = await fetchImpl(`${backend.baseUrl}/assistant/stream`, {
				method: 'POST',
				headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream'},
				body: JSON.stringify(req.body ?? {}),
				signal: ac.signal,
			})
			res.status(upstream.status)
			res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream')
			res.setHeader('Cache-Control', 'no-store')
			res.socket?.setNoDelay(true)
			if (!upstream.body) {
				clearTimeout(timer)
				return res.end()
			}
			const {Readable} = await import('node:stream')
			const body = Readable.fromWeb(upstream.body)
			const stop = () => clearTimeout(timer)
			body.on('end', stop)
			body.on('close', stop)
			body.on('error', () => {
				stop()
				if (!res.writableEnded) res.destroy()
			})
			body.pipe(res)
		} catch (error) {
			clearTimeout(timer)
			if (res.headersSent) {
				if (!res.writableEnded) res.destroy()
				return
			}
			if (error?.name === 'AbortError') {
				if (timedOut && !res.destroyed) res.status(504).json({error: {code: 'TIMEOUT', message: 'The assistant took too long'}})
				return
			}
			sendError(res, error)
		}
	})

	api.get('/hyprland/app-icon', async (req, res) => {
		const backend = getClient()
		const session = store.getSession(req.sid)
		if (!backend || !session) return res.status(401).end()
		const id = String(req.query.id ?? '')
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id)) return res.status(400).end()
		try {
			const token = await accessTokenFor(req.sid, session)
			const up = await fetchImpl(`${backend.baseUrl}/hyprland/app-icon?id=${encodeURIComponent(id)}`, {
				headers: {authorization: `Bearer ${token}`},
				signal: AbortSignal.timeout(8000),
			})
			if (!up.ok) return res.status(up.status).end()
			const rawCt = String(up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
			if (rawCt !== 'image/svg+xml' && rawCt !== 'image/png') return res.status(502).end()
			const MAX_ICON_BYTES = 2 * 1024 * 1024
			const declaredLen = Number(up.headers.get('content-length') || 0)
			if (Number.isFinite(declaredLen) && declaredLen > MAX_ICON_BYTES) return res.status(502).end()
			const chunks = []
			let total = 0
			if (up.body) {
				const reader = up.body.getReader()
				for (;;) {
					const {done, value} = await reader.read()
					if (done) break
					if (value) {
						total += value.byteLength
						if (total > MAX_ICON_BYTES) {
							await reader.cancel().catch(() => {})
							return res.status(502).end()
						}
						chunks.push(Buffer.from(value))
					}
				}
			}
			const buf = Buffer.concat(chunks, total)
			res.setHeader('Content-Type', rawCt)
			res.setHeader('Content-Security-Policy', 'sandbox')
			res.setHeader('X-Content-Type-Options', 'nosniff')
			res.setHeader('Cache-Control', 'private, max-age=3600')
			res.send(buf)
		} catch {
			res.status(502).end()
		}
	})

	api.get('/hyprland/events', async (req, res) => {
		const backend = getClient()
		const session = store.getSession(req.sid)
		if (!backend || !session) return res.status(401).end()
		const ac = new AbortController()
		const sidKey = hashId(req.sid)
		rememberSid(req.sid)
		const unregister = registerSessionStream(sidKey, () => {
			ac.abort()
			try {
				if (!res.writableEnded) res.end()
			} catch {}
		})
		res.on('close', () => {
			unregister()
			if (!res.writableEnded) ac.abort()
		})
		try {
			const token = await accessTokenFor(req.sid, session)
			const upstream = await fetchImpl(`${backend.baseUrl}/hyprland/events`, {
				headers: {authorization: `Bearer ${token}`, accept: 'text/event-stream'},
				signal: ac.signal,
			})
			if (!upstream.ok || !upstream.body) {
				unregister()
				return res.status(upstream.status || 502).end()
			}
			res.status(200)
			res.setHeader('Content-Type', 'text/event-stream')
			res.setHeader('Cache-Control', 'no-store')
			res.socket?.setNoDelay(true)
			const {Readable} = await import('node:stream')
			const body = Readable.fromWeb(upstream.body)
			body.on('end', unregister)
			body.on('close', unregister)
			body.on('error', () => {
				unregister()
				if (!res.writableEnded) res.destroy()
			})
			body.pipe(res)
		} catch {
			unregister()
			if (!res.headersSent) res.status(502).end()
		}
	})

	api.get('/backups/gdrive/callback', async (req, res) => {
		res.set('Cache-Control', 'no-store')
		const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))
		const page = (title, body, {ok = false, refreshUrl = '', linkHref = '', linkLabel = ''} = {}) =>
			res
				.status(ok || refreshUrl ? 200 : 400)
				.type('text/html; charset=utf-8')
				.send(
					`<!doctype html><meta charset="utf-8">${refreshUrl ? `<meta http-equiv="refresh" content="0;url=${esc(refreshUrl)}">` : ''}<title>${esc(title)}</title><body style="font:15px system-ui;background:#0f1117;color:#eef2ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px"><div style="max-width:460px;text-align:center"><h2>${esc(title)}</h2><p style="opacity:.82;line-height:1.45">${esc(body)}</p>${linkHref ? `<p style="margin-top:18px"><a href="${esc(linkHref)}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#38bdf8;color:#0b1120;font-weight:600;text-decoration:none">${esc(linkLabel || 'Continue')}</a></p>` : ok ? '<p><a href="/" style="color:#7dd3fc">Return to My Own Data Center</a></p>' : ''}</div></body>`,
				)
		if (req.query.error) return page('Google Drive sign-in cancelled', String(req.query.error))
		const code = String(req.query.code ?? '').trim()
		const state = String(req.query.state ?? '').trim()
		if (!code || !state) return page('Missing authorization code', 'Google didn’t return a code. Try connecting Google Drive again from the Backups screen.')
		// The My Own Data Center session cookie is SameSite=Strict, so browsers withhold it on the initial
		// cross-site redirect from accounts.google.com. A same-origin hop re-attaches the Strict cookie
		// without relaxing SameSite protection.
		if (!store.getSession(req.sid)) {
			const sameOriginUrl = `/api/backups/gdrive/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&r=1`
			if (req.query.r !== '1') {
				return page('Completing Google Drive sign-in…', 'Finishing secure handoff to My Own Data Center. Click below if this page doesn’t continue automatically.', {
					refreshUrl: sameOriginUrl,
					linkHref: sameOriginUrl,
					linkLabel: 'Complete Google Drive sign-in',
				})
			}
			return page(
				'Sign in required',
				'Your browser didn’t attach a My Own Data Center session cookie. Copy this tab’s full URL from the address bar and paste it into the “Paste callback URL” box on the Backups screen.',
				{linkHref: '/', linkLabel: 'Open My Own Data Center'},
			)
		}
		try {
			await authedCall(req, 'backups.gdrive.authFinish', 'mutation', {code, state})
			return page('Google Drive connected', 'Your Google Drive backup account is linked. You can close this tab and finish setup on the Backups screen.', {ok: true})
		} catch (e) {
			return page('Couldn’t connect Google Drive', e?.message || 'Sign-in failed')
		}
	})

	api.get('/health', (req, res) => res.json({ok: true, version: VERSION}))
	api.use((req, res) => res.status(404).json({error: {code: 'NOT_FOUND', message: 'Not found'}}))
	// Errors the routes above don't answer themselves (a malformed JSON body, a failed save) get
	// the JSON shape the web app reads, never Express's HTML page with file paths.
	api.use((error, req, res, next) => {
		if (res.headersSent) return next(error)
		const status = Number(error?.status ?? error?.statusCode)
		if (status >= 400 && status < 500) return res.status(status).json({error: {code: 'BAD_REQUEST', message: error.type === 'entity.parse.failed' ? 'Malformed JSON' : error.type === 'entity.too.large' ? (req.path === '/assistant/stream' ? 'That message is too long (the limit is about 100 KB)' : 'Request too large') : 'Bad request'}})
		console.error('[omarchy-server] api', error?.message ?? error)
		res.status(500).json({error: {code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong on the server'}})
	})
	// Quick transfer portal: no sign-in; the link is the permission (see quick-transfer.mjs).
	const transferOf = (req) => transfers.get(req.params.token, {sessionAlive: (sid) => !!store.getSession(sid)})
	const transferHeaders = (res) => res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff'})
	app.get('/transfer-portal.js', (_req, res) => res.set({'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'}).send(PORTAL_JS))
	app.get('/t/:token', (req, res) => {
		transferHeaders(res)
		res.status(transferOf(req) ? 200 : 404).type('html').send(portalHtml())
	})
	app.get('/t/:token/info', (req, res) => {
		transferHeaders(res)
		const s = transferOf(req)
		if (!s) return res.status(404).json({error: {code: 'NOT_FOUND', message: 'This link has ended'}})
		res.json({kind: s.kind, name: s.name, size: s.size, remainingMs: Math.max(0, s.expiresAt - Date.now()), theme: s.theme, background: !!s.bg && s.bg.kind !== 'color'})
	})
	const transferFile = fileGet('download', (req) => {
		const s = transferOf(req)
		return s && s.kind === 'download' ? {sid: s.sid, paths: [s.path]} : null
	})
	app.get('/t/:token/file', (req, res) => (transferHeaders(res), transferFile(req, res)))
	app.get('/t/:token/background', async (req, res) => {
		transferHeaders(res)
		const s = transferOf(req)
		const backend = getClient()
		if (!s?.bg || !backend) return res.status(404).end()
		try {
			if (s.bg.kind === 'photo') return res.type('image/jpeg').send(await readFile(backgroundFile(s.accountId)))
			const tries = s.bg.kind === 'wallpaper' ? [`/assets/wallpapers/generated-avif/medium/${s.bg.id}.avif`, `/assets/wallpapers/${s.bg.id}.jpg`] : [`/omarchy/background/${s.bg.id}`]
			for (const path of tries) {
				const r = await fetchImpl(`${backend.baseUrl}${path}`, {signal: AbortSignal.timeout(15_000)}).catch(() => null)
				const type = r?.headers.get('content-type') ?? ''
				if (r?.ok && type.startsWith('image/')) return res.type(type).send(Buffer.from(await r.arrayBuffer()))
			}
		} catch {
			/* no background */
		}
		res.status(404).end()
	})
	const transferUpload = relayUpload('upload', (req) => {
		const s = transferOf(req)
		if (!s || s.kind !== 'upload') return null
		const name = cleanUploadName(req.query.name)
		if (!name) return {sid: s.sid, error: 'That file name can’t be used'}
		return {sid: s.sid, path: `${s.path.replace(/\/+$/, '')}/${name}`}
	})
	app.post('/t/:token/upload', (req, res) => {
		transferHeaders(res)
		// Only the portal's own script sends this header; another site would need a CORS preflight, which is refused.
		if (req.headers['x-modc-transfer'] !== '1') return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Refused'}})
		transferUpload(req, res)
	})
	// This server's tools for a Hermes agent on another computer or in the cloud (Settings › Assistant ›
	// Hermes). omarchyd checks the token Hermes sends; without the right one nothing is answered.
	app.all('/mcp', async (req, res) => {
		const backend = getClient()
		if (!backend) return res.status(503).json({error: 'not set up'})
		if (req.method !== 'POST') return res.status(405).set('allow', 'POST').json({error: 'POST only'})
		try {
			const {Readable} = await import('node:stream')
			const up = await fetchImpl(`${backend.baseUrl}/mcp`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(typeof req.headers.authorization === 'string' ? {authorization: req.headers.authorization.slice(0, 600)} : {}),
				},
				body: Readable.toWeb(req),
				duplex: 'half',
				signal: AbortSignal.timeout(5 * 60_000),
			})
			res.status(up.status).set({'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store'})
			res.send(Buffer.from(await up.arrayBuffer()))
		} catch {
			res.status(502).json({error: 'unavailable'})
		}
	})
	app.use('/api', api)

	// ---- PWA -----------------------------------------------------------------
	if (staticDir && existsSync(staticDir)) {
		app.use('/assets', express.static(join(staticDir, 'assets'), {immutable: true, maxAge: '1y'}))
		app.use('/assets', (_req, res) => res.status(404).end())
		app.use(express.static(staticDir, {index: false, maxAge: 0}))
		app.get('*', (req, res) => {
			if (req.path.startsWith('/.well-known/') || /\/[^/]+\.[^/]+$/.test(req.path)) return res.status(404).end()
			res.set('Cache-Control', 'no-cache').sendFile(join(staticDir, 'index.html'))
		})
	}
	// Anything the routes above don't answer (a path that is not valid percent-encoding, say) would get
	// Express's HTML error page with a stack trace and this server's file paths, even from someone not signed in.
	app.use((error, req, res, next) => {
		if (res.headersSent) return next(error)
		const status = Number(error?.status ?? error?.statusCode)
		if (status >= 400 && status < 500) return res.status(status).type('text/plain').send('Bad request')
		console.error('[omarchy-server]', error?.message ?? error)
		res.status(500).type('text/plain').send('Something went wrong')
	})
	return app
}
