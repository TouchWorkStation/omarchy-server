// HTTPS on the home network. Some apps only work on a secure (https://) page: browsers keep
// features such as WebCodecs (Selkies browsers like Brave), service workers and the Web Crypto API
// (Vaultwarden, Actual) for secure pages. Omarchy Server makes its own small certificate authority
// once, issues this server a certificate for its own addresses, and serves https:// on the same
// ports as http://, so nothing else changes: the first bytes of a connection say which it is.
//
// The authority's private key never leaves this server (mode 0600). Installing its certificate on
// your devices (Settings → Secure connection) makes browsers trust these pages without a warning.
import {execFile} from 'node:child_process'
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {Duplex} from 'node:stream'
import tls from 'node:tls'

export const defaultTlsDir = () => process.env.OMARCHY_TLS_DIR ?? join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'omarchy-server', 'tls')
const DAY = 86_400_000

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
	const want = JSON.stringify(names)
	const read = async () => {
		const [key, cert, ca, info] = await Promise.all(['server.key', 'server.crt', 'ca.crt', 'server.json'].map((f) => readFile(join(dir, f), 'utf8').catch(() => null)))
		return {key, cert, ca, info: info ? JSON.parse(info) : null}
	}
	const fresh = (c) => c.key && c.cert && c.ca && c.info?.names === want && c.info.expires - Date.now() > 30 * DAY
	let current = await read()
	if (fresh(current)) return current
	return withLock(dir, async () => {
		current = await read()
		if (fresh(current)) return current
		const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'omarchy'
		if (!(await stat(join(dir, 'ca.key')).catch(() => null)) || !current.ca) {
			await openssl(['req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-subj', `/O=Omarchy Server/CN=Omarchy Server ${host}`, '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], {cwd: dir})
		}
		const san = [...names.dns.map((d) => `DNS:${d}`), ...names.ips.map((i) => `IP:${i}`)].join(',')
		await writeFile(join(dir, 'ext.cnf'), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`)
		await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'server.key.new', '-out', 'server.csr', '-subj', `/CN=${host}`], {cwd: dir})
		// 397 days: the longest browsers accept for a server certificate.
		await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt.new', '-days', '397', '-extfile', 'ext.cnf'], {cwd: dir})
		await rename(join(dir, 'server.key.new'), join(dir, 'server.key'))
		await rename(join(dir, 'server.crt.new'), join(dir, 'server.crt'))
		await writeFile(join(dir, 'server.json'), JSON.stringify({names: want, expires: Date.now() + 397 * DAY}), {mode: 0o600})
		await rm(join(dir, 'server.csr'), {force: true})
		await rm(join(dir, 'ext.cnf'), {force: true})
		return read()
	})
}

// A secure context for servers, kept current (addresses change; certificates renew).
export function tlsContext({dir = defaultTlsDir(), refreshMs = 10 * 60_000, lazy = false} = {}) {
	let ctx = null
	let ca = null
	let started = null
	let timer = null
	let closed = false
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
	// Made on first use when lazy (nothing to do on a server with no apps yet).
	const start = () => {
		if (!started) {
			started = load()
			timer = setInterval(load, refreshMs)
			timer.unref?.()
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
		close: () => {
			closed = true
			if (timer) clearInterval(timer)
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
