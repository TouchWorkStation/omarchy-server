// HTTPS on the home network. Some apps only work on a secure (https://) page: browsers keep
// features such as WebCodecs (Selkies browsers like Brave), service workers and the Web Crypto API
// (Vaultwarden, Actual) for secure pages. Omarchy Server makes its own small certificate authority
// once, issues this server a certificate for its own addresses, and serves https:// on the same
// ports as http://, so nothing else changes: the first bytes of a connection say which it is.
//
// The authority's private key never leaves this server (mode 0600). Installing its certificate on
// your devices (Settings → Secure connection) makes browsers trust these pages without a warning.
//
// Authorities made from 0.9.4 on are restricted (X.509 name constraints): browsers only accept
// what they sign for home-network names (localhost, *.local, *.lan, *.home.arpa, *.internal, this
// server's own name) and private addresses. So even if this server were ever broken into, its key
// couldn't be used to impersonate a real website on your devices. Servers set up earlier keep the
// authority your devices already trust until the owner chooses to replace it (rotateAuthority).
import {execFile} from 'node:child_process'
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {Duplex} from 'node:stream'
import tls from 'node:tls'

export const defaultTlsDir = () => process.env.OMARCHY_TLS_DIR ?? join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'omarchy-server', 'tls')
const DAY = 86_400_000

// What a restricted authority may sign for.
const HOME_DOMAINS = ['localhost', 'local', 'lan', 'home.arpa', 'internal']
const PRIVATE_V4 = [
	['10.0.0.0', 8],
	['172.16.0.0', 12],
	['192.168.0.0', 16],
	['100.64.0.0', 10], // carrier-grade NAT, used by Tailscale and similar
	['127.0.0.0', 8],
]
const v4 = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
const maskOf = (bits) => [24, 16, 8, 0].map((sh) => ((bits >= 32 - sh ? 255 : bits <= 24 - sh ? 0 : (0xff << (8 - (bits - (24 - sh)))) & 0xff))).join('.')
export function privateAddress(ip) {
	if (net.isIPv4(ip)) return PRIVATE_V4.some(([base, bits]) => v4(ip) >>> (32 - bits) === v4(base) >>> (32 - bits))
	if (net.isIPv6(ip)) return ip === '::1' || /^f[cd][0-9a-f]{0,2}:/i.test(ip)
	return false
}
const permittedDns = (host) => [...new Set([...HOME_DOMAINS, host])]
const dnsAllowed = (name, permitted) => permitted.some((p) => name === p || name.endsWith(`.${p}`))
function nameConstraints(host) {
	const dns = permittedDns(host).map((d) => `permitted;DNS:${d}`)
	const ips = PRIVATE_V4.map(([base, bits]) => `permitted;IP:${base}/${maskOf(bits)}`)
	ips.push('permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'permitted;IP:fc00::/fe00::')
	return `nameConstraints=critical,${[...dns, ...ips].join(',')}`
}

function openssl(args, {cwd} = {}) {
	return new Promise((resolve, reject) =>
		execFile('openssl', args, {cwd, timeout: 60_000}, (error, stdout, stderr) => (error ? reject(new Error(`openssl ${args[0]}: ${String(stderr || error.message).trim()}`)) : resolve(stdout))),
	)
}

// Every address this server can be reached at on the network, plus its names.
export function serverNames() {
	const ips = new Set(['127.0.0.1', '::1'])
	for (const list of Object.values(os.networkInterfaces()))
		for (const i of list ?? []) if (!i.address.startsWith('fe80') && !/^(169\.254)\./.test(i.address)) ips.add(i.address)
	const host = os.hostname().toLowerCase().replace(/[^a-z0-9.-]/g, '') || 'omarchy'
	const dns = new Set(['localhost', host, ...(host.includes('.') ? [] : [`${host}.local`])])
	return {ips: [...ips].sort(), dns: [...dns].sort()}
}

async function withLock(dir, fn) {
	const lock = join(dir, '.lock')
	for (let i = 0; ; i++) {
		try {
			await mkdir(lock)
			break
		} catch {
			const st = await stat(lock).catch(() => null)
			if (st && Date.now() - st.mtimeMs > 60_000) await rm(lock, {recursive: true, force: true})
			if (i > 600) throw new Error('Timed out waiting for the certificate lock')
			await new Promise((r) => setTimeout(r, 100))
		}
	}
	try {
		return await fn()
	} finally {
		await rm(lock, {recursive: true, force: true})
	}
}

// Make (or renew) the authority and this server's certificate. Returns PEM strings.
export async function ensureTls({dir = defaultTlsDir(), names = serverNames()} = {}) {
	await mkdir(dir, {recursive: true, mode: 0o700})
	const read = async () => {
		const [key, cert, ca, info] = await Promise.all(['server.key', 'server.crt', 'ca.crt', 'server.json'].map((f) => readFile(join(dir, f), 'utf8').catch(() => null)))
		return {key, cert, ca, info: info ? JSON.parse(info) : null}
	}
	const fresh = (c) => c.key && c.cert && c.ca && c.info?.names === want && c.info.expires - Date.now() > 30 * DAY
	// A restricted authority only signs names and addresses inside what it's allowed.
	const authority = JSON.parse((await readFile(join(dir, 'ca.json'), 'utf8').catch(() => null)) ?? 'null')
	if (authority?.restricted) names = {dns: names.dns.filter((d) => dnsAllowed(d, authority.dns)), ips: names.ips.filter(privateAddress)}
	const want = JSON.stringify(names)
	let current = await read()
	if (fresh(current)) return current
	return withLock(dir, async () => {
		current = await read()
		if (fresh(current)) return current
		const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'omarchy'
		if (!(await stat(join(dir, 'ca.key')).catch(() => null)) || !current.ca) {
			const short = host.toLowerCase()
			await openssl(['req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-subj', `/O=Omarchy Server/CN=Omarchy Server ${host}`, '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', nameConstraints(short)], {cwd: dir})
			await writeFile(join(dir, 'ca.json'), JSON.stringify({restricted: true, dns: permittedDns(short), created: Date.now()}), {mode: 0o600})
			// The new authority can only sign what it's allowed: start over with those names.
			await rm(join(dir, 'server.json'), {force: true})
			names = {dns: names.dns.filter((d) => dnsAllowed(d, permittedDns(short))), ips: names.ips.filter(privateAddress)}
		}
		const san = [...names.dns.map((d) => `DNS:${d}`), ...names.ips.map((i) => `IP:${i}`)].join(',')
		await writeFile(join(dir, 'ext.cnf'), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`)
		await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'server.key.new', '-out', 'server.csr', '-subj', `/CN=${host}`], {cwd: dir})
		// 397 days: the longest browsers accept for a server certificate.
		await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt.new', '-days', '397', '-extfile', 'ext.cnf'], {cwd: dir})
		await rename(join(dir, 'server.key.new'), join(dir, 'server.key'))
		await rename(join(dir, 'server.crt.new'), join(dir, 'server.crt'))
		await writeFile(join(dir, 'server.json'), JSON.stringify({names: JSON.stringify(names), expires: Date.now() + 397 * DAY}), {mode: 0o600})
		await rm(join(dir, 'server.csr'), {force: true})
		await rm(join(dir, 'ext.cnf'), {force: true})
		return read()
	})
}

export async function authorityInfo(dir = defaultTlsDir()) {
	const meta = JSON.parse((await readFile(join(dir, 'ca.json'), 'utf8').catch(() => null)) ?? 'null')
	const exists = !!(await stat(join(dir, 'ca.crt')).catch(() => null))
	return {exists, restricted: !!meta?.restricted}
}

// Replace the authority with a new, restricted one. The old files are kept in retired-<time>/
// (still mode 0700) rather than deleted. Devices that trusted the old one need the new certificate.
export async function rotateAuthority({dir = defaultTlsDir(), names = serverNames()} = {}) {
	await mkdir(dir, {recursive: true, mode: 0o700})
	await withLock(dir, async () => {
		const old = join(dir, `retired-${new Date().toISOString().replace(/[:.]/g, '-')}`)
		await mkdir(old, {mode: 0o700})
		for (const f of ['ca.key', 'ca.crt', 'ca.srl', 'ca.json', 'server.key', 'server.crt', 'server.json']) await rename(join(dir, f), join(old, f)).catch(() => {})
	})
	return ensureTls({dir, names})
}

// Settings both the web server and the app gateways follow, kept beside the certificates.
export async function readPolicy(dir = defaultTlsDir()) {
	const p = JSON.parse((await readFile(join(dir, 'policy.json'), 'utf8').catch(() => null)) ?? '{}')
	return {alwaysHttps: p?.alwaysHttps === true}
}
export async function writePolicy(dir = defaultTlsDir(), patch = {}) {
	await mkdir(dir, {recursive: true, mode: 0o700})
	const next = {...(await readPolicy(dir)), ...patch}
	await writeFile(join(dir, 'policy.json.tmp'), JSON.stringify(next), {mode: 0o600})
	await rename(join(dir, 'policy.json.tmp'), join(dir, 'policy.json'))
	return next
}

// Should this plain-http request be sent to https:// instead? Only a browser opening a page
// (never an app's own API client, a download or a websocket), and only when it's turned on.
export function wantsUpgrade(req, policy, ctx) {
	if (!policy?.alwaysHttps || !ctx || req.socket?.encrypted) return false
	// Behind a proxy that already handles https (remote access): it decides, not us.
	if (req.headers['x-forwarded-proto']) return false
	if (req.method !== 'GET' && req.method !== 'HEAD') return false
	const mode = req.headers['sec-fetch-mode']
	if (mode) return mode === 'navigate'
	return /text\/html/.test(req.headers.accept ?? '') && !req.headers.upgrade
}

// A secure context for servers, kept current (addresses change; certificates renew).
export function tlsContext({dir = defaultTlsDir(), refreshMs = 10 * 60_000, lazy = false} = {}) {
	let ctx = null
	let ca = null
	let started = null
	let timer = null
	let closed = false
	let policy = {alwaysHttps: false}
	let seen = ''
	let poll = null
	const load = async () => {
		if (closed) return
		try {
			const t = await ensureTls({dir})
			ctx = tls.createSecureContext({key: t.key, cert: t.cert})
			ca = t.ca
		} catch (error) {
			console.error('[omarchy-server] HTTPS unavailable:', error.message)
		}
	}
	// Notice a replaced certificate or a changed setting within seconds (the other process may
	// have made the change).
	const check = async () => {
		const marks = await Promise.all(['server.crt', 'policy.json'].map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)))
		const key = marks.join(':')
		if (key === seen) return
		const certChanged = seen && seen.split(':')[0] !== String(marks[0])
		seen = key
		policy = await readPolicy(dir)
		if (certChanged) await load()
	}
	// Made on first use when lazy (nothing to do on a server with no apps yet).
	const start = () => {
		if (!started) {
			started = load().then(check)
			timer = setInterval(load, refreshMs)
			timer.unref?.()
			poll = setInterval(() => check().catch(() => {}), 3000)
			poll.unref?.()
		}
		return started
	}
	if (!lazy) start()
	return {
		get ready() {
			return start()
		},
		start,
		get: () => ctx,
		ca: () => ca,
		policy: () => policy,
		dir,
		// After a change made in this process: pick it up now.
		refresh: async () => {
			seen = ''
			await load()
			await check()
		},
		close: () => {
			closed = true
			if (timer) clearInterval(timer)
			if (poll) clearInterval(poll)
		},
	}
}

// Listen for both http:// and https:// on one port and hand every connection to `server` (an
// http.Server, with its own request and upgrade handlers). Requests over TLS have
// req.socket.encrypted set. Returns the listening net.Server.
export function dualProtocolServer(server, getContext) {
	const front = net.createServer((socket) => {
		socket.once('error', () => socket.destroy())
		socket.once('data', (first) => {
			socket.pause()
			const ctx = getContext?.()
			if (first[0] === 0x16 && ctx) {
				// TLS reads the connection itself, so it gets a stream that starts with the bytes
				// already read (handing it the socket would skip them).
				const stream = new Duplex({
					read() {
						socket.resume()
					},
					write(chunk, enc, cb) {
						socket.write(chunk, enc, cb)
					},
					final(cb) {
						socket.end(cb)
					},
					destroy(err, cb) {
						socket.destroy(err ?? undefined)
						cb(err)
					},
				})
				socket.on('data', (c) => {
					if (!stream.push(c)) socket.pause()
				})
				socket.on('end', () => stream.push(null))
				socket.on('close', () => stream.destroy())
				const secure = new tls.TLSSocket(stream, {isServer: true, secureContext: ctx, ALPNProtocols: ['http/1.1']})
				for (const k of ['remoteAddress', 'remotePort', 'remoteFamily', 'localAddress', 'localPort']) Object.defineProperty(secure, k, {get: () => socket[k]})
				secure.on('error', () => secure.destroy())
				stream.push(first)
				socket.resume()
				server.emit('connection', secure)
				return
			}
			socket.unshift(first)
			server.emit('connection', socket)
			socket.resume()
		})
	})
	front.on('close', () => server.close())
	return front
}
