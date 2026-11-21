// Local swarm: other Linux computers joined to this server through the Omarchy Server connector
// (connector/agent.py). The connector dials *out* to this server over wss:// (pinned to this
// server's own certificate authority), so the other computer opens no ports.
//
// Joining: the owner makes a one-time pairing code (15 minutes, used once) with the abilities they
// allow (watching is always on; terminal, desktop, manage, storage, backup and files are optional). The connector trades
// it for its own id and key; only a hash of the key is kept here.
//
// Two limits on what a computer does: the abilities chosen when pairing, which the connector also
// keeps itself and enforces on its own side (so even this server can't widen them), and the
// owner's switches here, which can only narrow those.
//
// Wire format on the connector's WebSocket: JSON text messages for control, and binary frames
// starting with a 4-byte channel number for terminal, desktop, and file bytes.
import {X509Certificate, createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {WebSocketServer} from 'ws'

import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'
import {parseResize} from './terminal.mjs'

// backup: the computer backs up folders you choose to this server (see backups.mjs). Its restic
// uploads through the connector's own pinned connection, and can only add backups, never delete them.
// storage: see its drives, format extra disks, and manage pools on that computer (connector/helper.py).
const ABILITIES = ['terminal', 'desktop', 'manage', 'storage', 'backup', 'files']
const PAIR_TTL = 15 * 60_000
// A viewer that stops reading must not queue connector frames in memory without a bound.
const VIEWER_BUFFER_LIMIT = 1024 * 1024
// File bytes use their own channel. Chunks stay small, and only a few are in flight, so a big
// copy cannot fill the socket or stall a terminal on the same computer.
const FILE_CHUNK = 64 * 1024
const FILE_WINDOW = 4
const FILE_MS = 10 * 60_000
const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const clip = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n)
// RFC 6455: a close reason longer than 123 bytes throws RangeError inside ws and takes the process down.
// clip() counts characters, so a name in another language still overflows. Cut on a byte boundary instead.
export function closeReason(text) {
	const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
	const buf = Buffer.from(clean)
	if (buf.length <= 123) return clean
	let end = 123
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
	return buf.subarray(0, end).toString('utf8')
}
function closeSocket(ws, code, reason) {
	try {
		ws.close(code, closeReason(reason))
	} catch (e) {
		if (!(e instanceof RangeError)) throw e
		ws.close(code)
	}
}
// Same sentence a refused new connection gets, so an open session ends with that reason too.
function switchedOff(name, ability) {
	const what = ability === 'terminal' ? 'The terminal' : ability === 'files' ? 'Files' : 'The desktop'
	return `${what} isn’t switched on for ${name}`
}
function closeLiveChannel(l, ch, reason) {
	const channel = l.channels.get(ch)
	if (!channel) return
	if (channel.kind === 'file') return channel.end(new RpcError('FORBIDDEN', reason))
	l.channels.delete(ch)
	closeSocket(channel.ws, 1011, reason)
	if (l.ws.readyState === l.ws.OPEN) l.ws.send(JSON.stringify({op: 'close', ch}))
}
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
// A dropped connection, a slow answer, or a reconnect is not a reason to reinstall.
// Only a connector that doesn't know the call, or a helper that isn't there, is.
function storageReadError(e, name) {
	const message = String(e?.message ?? '')
	const stale = /unknown action|storage helper|helper failed|helper\.py/i.test(message)
	const pass = /offline|reconnected|didn[\u2019']t answer in time/i.test(message)
	if (stale && !pass) return new RpcError('PRECONDITION_FAILED', `Run the connector install again on ${name}.`)
	return new RpcError('PRECONDITION_FAILED', message)
}

// Only the facts the page shows, checked and trimmed (a connector is another computer: don't
// trust its numbers to be well-formed).
const BATTERY_STATUS = new Set(['charging', 'discharging', 'full', 'not-charging', 'unknown'])

export function cleanMetrics(m = {}) {
	const disks = Array.isArray(m.disks)
		? m.disks.slice(0, 12).map((d) => ({mount: clip(d?.mount, 200), total: num(d?.total), used: num(d?.used)})).filter((d) => d.total > 0)
		: []
	const gpus = Array.isArray(m.gpus)
		? m.gpus.slice(0, 8).map((g) => ({id: clip(g?.id, 80), index: num(g?.index) ?? 0, name: clip(g?.name, 80), used: num(g?.used)})).filter((g) => g.id)
		: []
	const batteries = Array.isArray(m.batteries)
		? m.batteries
				.slice(0, 4)
				.map((b) => ({
					id: clip(b?.id, 32),
					index: num(b?.index) ?? 0,
					name: clip(b?.name, 80),
					percent: num(b?.percent),
					status: BATTERY_STATUS.has(b?.status) ? b.status : 'unknown',
					secondsRemaining: num(b?.secondsRemaining),
					power: num(b?.power),
					energyNow: num(b?.energyNow),
					energyFull: num(b?.energyFull),
				}))
				.filter((b) => b.id)
		: []
	return {
		at: Date.now(),
		cpu: num(m.cpu),
		cores: num(m.cores),
		load: Array.isArray(m.load) ? m.load.slice(0, 3).map(num) : [],
		mem: {total: num(m.mem?.total), used: num(m.mem?.used)},
		swap: {total: num(m.swap?.total), used: num(m.swap?.used)},
		disks,
		gpus,
		batteries,
		temp: num(m.temp),
		uptime: num(m.uptime),
		updates: num(m.updates),
	}
}
function cleanInfo(i = {}) {
	return {
		hostname: clip(i.hostname, 64),
		os: clip(i.os, 80),
		osId: clip(i.osId, 32).toLowerCase(),
		kernel: clip(i.kernel, 64),
		arch: clip(i.arch, 16),
		user: clip(i.user, 32),
		version: clip(i.version, 16),
		pkg: clip(i.pkg, 16),
		updateCommand: clip(i.updateCommand, 160),
		omarchy: !!i.omarchy,
		plugins: Array.isArray(i.plugins) ? i.plugins.slice(0, 200).map((p) => clip(p, 80)) : [],
		themes: Array.isArray(i.themes) ? i.themes.slice(0, 200).map((t) => clip(t, 80)) : [],
		theme: clip(i.theme, 80),
		desktop: {kind: clip(i.desktop?.kind, 32), ok: !!i.desktop?.ok, why: clip(i.desktop?.why, 200)},
	}
}

// This server's addresses other computers can reach: its network addresses (Tailscale's too).
function serverAddresses() {
	const out = []
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		for (const i of list ?? []) {
			if (i.internal || i.family !== 'IPv4' || /^(docker|podman|veth|virbr|br-|cni)/.test(name)) continue
			out.push({address: i.address, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address) || name.startsWith('tailscale')})
		}
	}
	return out
}

export function createConnector({dataDir, tlsDir, plugins = null, source = async () => 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server', webPort = 7780, now = () => Date.now()}) {
	const file = join(dataDir, 'swarm.json')
	let state = {agents: []}
	// Set when swarm.json exists but cannot be used. Nothing may write it until the owner repairs it.
	let damaged = false
	const agentOk = (a) => !!a && typeof a === 'object' && !Array.isArray(a) && typeof a.id === 'string' && !!a.allowed && typeof a.allowed === 'object' && !Array.isArray(a.allowed) && !!a.on && typeof a.on === 'object' && !Array.isArray(a.on)
	// A missing file is no computers yet. A parse error used to reject this promise with nobody
	// waiting, which ended the process. The file stays so its key hashes can be repaired.
	const loaded = (async () => {
		let text
		try {
			text = await readFile(file, 'utf8')
		} catch (error) {
			if (error.code === 'ENOENT') return
			damaged = true
			console.error('[omarchyd] couldn’t load swarm.json; leaving it unchanged')
			return
		}
		let data
		try {
			data = JSON.parse(text)
		} catch {
			data = undefined
		}
		const ok = !!data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.agents) && data.agents.every(agentOk)
		if (ok) state = data
		else {
			damaged = true
			console.error('[omarchyd] couldn’t load swarm.json; leaving it unchanged')
		}
	})()
	const save = () => (damaged ? Promise.reject(new RpcError('PRECONDITION_FAILED', 'swarm.json is damaged and was left unchanged.')) : writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600}))
	const pairings = new Map() // sha(token) -> {abilities, expires}
	const live = new Map() // agentId -> {ws, metrics, info, channels: Map, nextCh, calls: Map, nextCall}
	const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024})

	const find = (id) => state.agents.find((a) => a.id === id)
	const view = (a) => {
		const l = live.get(a.id)
		return {
			id: a.id,
			name: a.name,
			online: !!l,
			lastSeen: l ? now() : (a.lastSeen ?? null),
			enrolledAt: a.enrolledAt,
			// What it may do: allowed at pairing (and by the connector itself) and still switched on here.
			allowed: a.allowed,
			on: a.on,
			info: a.info ?? null,
			metrics: l?.metrics ?? a.metrics ?? null,
		}
	}

	async function caFingerprint() {
		const pem = await readFile(join(tlsDir, 'ca.crt'), 'utf8').catch(() => null)
		if (!pem) throw new RpcError('PRECONDITION_FAILED', 'This server’s secure address (https) isn’t set up yet, and the connector needs it.')
		return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase()
	}

	// ---- owner actions (tRPC) ------------------------------------------------------------------
	async function pair(input = {}) {
		await loaded
		const abilities = Object.fromEntries(ABILITIES.map((k) => [k, input?.[k] === true]))
		const token = randomBytes(24).toString('base64url')
		for (const [k, p] of pairings) if (p.expires < now()) pairings.delete(k)
		pairings.set(sha(token), {abilities, expires: now() + PAIR_TTL})
		return {token, ca: await caFingerprint(), expiresAt: now() + PAIR_TTL, abilities, source: await source(), port: webPort, addresses: serverAddresses()}
	}
	// Fleet gauges sample only while this server is reading them. A list (the swarm
	// screen, or the assistant) asks each computer to sample; the connector stops
	// on its own about 15s after the last ask.
	let watchedAt = 0
	function watchLive() {
		const t = Date.now()
		if (t - watchedAt < 2_000) return
		watchedAt = t
		for (const l of live.values()) {
			if (l.ws.readyState !== l.ws.OPEN) continue
			try {
				l.ws.send(JSON.stringify({op: 'watch'}))
			} catch {}
		}
	}
	async function list() {
		await loaded
		watchLive()
		return state.agents.map(view)
	}
	async function remove(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		state.agents = state.agents.filter((x) => x !== a)
		await save()
		const l = live.get(a.id)
		// Tell it to forget this server and stop; then cut it off either way.
		if (l) {
			try {
				l.ws.send(JSON.stringify({op: 'removed'}))
			} catch {}
			setTimeout(() => l.ws.terminate(), 500).unref?.()
		}
		return true
	}
	async function rename(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const name = clip(input?.name, 48).trim()
		if (!name) throw new RpcError('BAD_REQUEST', 'Give it a name')
		// Joining already picks a free suffix. A person renaming is told the name is taken.
		if (name !== a.name && state.agents.some((other) => other.name === name)) throw new RpcError('CONFLICT', 'That name’s already taken')
		a.name = name
		await save()
		return true
	}
	// Switch abilities on or off here. Never more than it was allowed when it joined.
	async function setAbilities(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		// Check the whole request before changing anything, so a later refusal cannot leave
		// earlier abilities off in memory while the file and the open session still say on.
		const next = {...a.on}
		for (const k of ABILITIES) {
			if (input?.[k] === undefined) continue
			if (input[k] === true && !a.allowed[k]) throw new RpcError('FORBIDDEN', `${a.name} wasn’t allowed ${k} when it joined. Pair it again with ${k} switched on to allow it.`)
			next[k] = input[k] === true && a.allowed[k]
		}
		a.on = next
		await save()
		// A switch only saved before, so a terminal or desktop already open kept forwarding.
		const l = live.get(a.id)
		if (l) {
			for (const [ch, channel] of [...l.channels]) {
				const ability = channel.kind === 'pty' ? 'terminal' : channel.kind === 'vnc' ? 'desktop' : channel.kind === 'file' ? 'files' : null
				if (ability && !may(a, ability)) closeLiveChannel(l, ch, switchedOff(a.name, ability))
			}
		}
		return true
	}
	const may = (a, ability) => a.allowed[ability] && a.on[ability]

	async function requireAgent(input, needStorage) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', 'That computer is offline right now')
		if (needStorage && !may(a, 'storage')) throw new RpcError('FORBIDDEN', `Pair ${a.name} again with Storage switched on`)
		return a
	}

	function call(id, name, args = {}, timeout = 10 * 60_000) {
		const l = live.get(id)
		if (!l) return Promise.reject(new RpcError('PRECONDITION_FAILED', 'That computer is offline right now'))
		const n = ++l.nextCall
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => (l.calls.delete(n), reject(new RpcError('BAD_GATEWAY', 'That computer didn’t answer in time'))), timeout)
			l.calls.set(n, {resolve, reject, timer})
			l.ws.send(JSON.stringify({op: 'call', id: n, name, args}))
		})
	}
	// Manage: a short list of things the connector knows how to do itself (it has no "run this").
	async function action(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!may(a, 'manage')) throw new RpcError('FORBIDDEN', `Managing ${a.name} isn’t switched on`)
		const name = String(input?.name ?? '')
		if (name === 'plugin-install') {
			// Same rule as the App Store: only verified plugins, at the verified commit.
			const p = await plugins?.find(String(input?.pluginId ?? ''))
			if (!p) throw new RpcError('NOT_FOUND', 'That plugin isn’t in the verified list')
			return call(a.id, 'plugin-install', {id: p.id, repo: p.repo, commit: p.commit})
		}
		if (name === 'plugin-remove') return call(a.id, 'plugin-remove', {id: clip(input?.pluginId, 80)})
		if (name === 'theme-set') return call(a.id, 'theme-set', {name: clip(input?.theme, 80)})
		if (name === 'reboot') return call(a.id, 'reboot', {}, 30_000)
		throw new RpcError('BAD_REQUEST', 'Unknown action')
	}

	// ---- connector side (HTTP enroll + WebSocket) ----------------------------------------------
	const enrollTries = []
	async function enroll(body) {
		await loaded
		// An error string, the shape the installer already prints, instead of a thrown object.
		// The pairing code is not used, and this does not count toward the rate limit.
		if (damaged) return {status: 503, body: {error: 'swarm.json is damaged and was left unchanged.'}}
		// A handful of tries a minute is plenty for people; it stops guessing.
		const t = now()
		while (enrollTries.length && enrollTries[0] < t - 60_000) enrollTries.shift()
		if (enrollTries.length >= 20) return {status: 429, body: {error: 'Too many tries. Wait a minute.'}}
		enrollTries.push(t)
		const p = pairings.get(sha(body?.token ?? ''))
		pairings.delete(sha(body?.token ?? ''))
		if (!p || p.expires < t) return {status: 401, body: {error: 'That pairing code isn’t valid any more. Make a new one in Machines → Local swarm → Add a computer.'}}
		const info = cleanInfo(body?.info)
		// The connector's own limits (what its installer was told) and the pairing's, together.
		const local = body?.abilities ?? {}
		const allowed = Object.fromEntries(ABILITIES.map((k) => [k, p.abilities[k] === true && local[k] === true]))
		const id = randomBytes(6).toString('hex')
		const key = randomBytes(32).toString('base64url')
		let name = info.hostname || 'computer'
		for (let n = 2; state.agents.some((a) => a.name === name); n++) name = `${info.hostname || 'computer'} ${n}`
		state.agents.push({id, name, keyHash: sha(key), allowed, on: {...allowed}, enrolledAt: t, lastSeen: null, info})
		await save()
		return {status: 200, body: {id, key, name, abilities: allowed}}
	}

	function authAgent(req) {
		const m = /^Bearer ([0-9a-f]{12}):([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))
		if (!m) return null
		const a = find(m[1])
		return a && sameHash(a.keyHash, sha(m[2])) ? a : null
	}

	async function upgradeAgent(req, socket, head) {
		await loaded
		// 401 is the connector's signal that this computer was removed, and it then deletes its key.
		// A file that cannot be read is not that: answer 503 so the computer keeps its key and retries.
		if (damaged) {
			socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
			return socket.destroy()
		}
		const a = authAgent(req)
		if (!a) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
			return socket.destroy()
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			// One connection per computer: a new one replaces the old. Its viewers and waiting calls
			// end now (its own close handler sees it's no longer the live one and skips this).
			const old = live.get(a.id)
			if (old) {
				old.progress = null
				for (const ch of [...old.channels.values()]) {
					if (ch.kind === 'file') ch.end(new RpcError('BAD_GATEWAY', 'The computer reconnected'))
					else closeSocket(ch.ws, 1000, 'The computer reconnected')
				}
				for (const c of old.calls.values()) (clearTimeout(c.timer), c.reject(new RpcError('BAD_GATEWAY', 'The computer reconnected')))
				old.channels.clear()
				old.calls.clear()
				old.ws.terminate()
			}
			const l = {ws, metrics: a.metrics ?? null, channels: new Map(), nextCh: 0, calls: new Map(), nextCall: 0}
			live.set(a.id, l)
			const alive = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000)
			ws.on('message', async (data, isBinary) => {
				try {
					if (isBinary) {
						const buf = Buffer.from(data)
						if (buf.length < 4) return
						const id = buf.readUInt32BE(0)
						const ch = l.channels.get(id)
						// A file channel has no browser socket. Touching ch.ws here would throw.
						if (ch?.kind === 'file') {
							ch.onBinary(buf.subarray(4))
							return
						}
						if (ch && ch.ws.readyState === ch.ws.OPEN) {
							if (ch.ws.bufferedAmount > VIEWER_BUFFER_LIMIT) closeLiveChannel(l, id, 'The viewer fell behind')
							else ch.ws.send(buf.subarray(4), {binary: true})
						}
						return
					}
					let msg
					try {
						msg = JSON.parse(String(data))
					} catch {
						return
					}
					if (msg.op === 'hello') {
						a.info = cleanInfo(msg.info)
						// The connector's own limits win if they're narrower than what was stored.
						for (const k of ABILITIES) if (msg.abilities?.[k] !== true) a.allowed[k] = a.on[k] = false
						a.lastSeen = now()
						// A full disk must not reject this listener: that rejection is unhandled and exits the process.
						try {
							await save()
						} catch {
							console.error('[omarchyd] couldn’t save swarm.json')
						}
					} else if (msg.op === 'metrics') {
						l.metrics = cleanMetrics(msg.metrics)
						a.metrics = l.metrics
					} else if (msg.op === 'file' || msg.op === 'ack') {
						const ch = l.channels.get(Number(msg.ch))
						if (ch?.kind === 'file') ch.onControl(msg)
					} else if (msg.op === 'closed') {
						const ch = l.channels.get(Number(msg.ch))
						if (!ch) return
						if (ch.kind === 'file') {
							ch.onControl(msg)
							return
						}
						l.channels.delete(Number(msg.ch))
						closeSocket(ch.ws, msg.code === 1011 ? 1011 : 1000, msg.reason)
					} else if (msg.op === 'progress') {
						// A long call (a backup) saying how far it's got. A report for a call that
						// already finished must not become the next call's progress.
						const callId = Number(msg.id)
						if (!l.calls.has(callId)) return
						l.progress = {call: callId, percent: Math.max(0, Math.min(1, num(msg.percent) ?? 0)), step: clip(msg.step, 80), at: now()}
					} else if (msg.op === 'result') {
						const callId = Number(msg.id)
						const c = l.calls.get(callId)
						if (!c) return
						l.calls.delete(callId)
						clearTimeout(c.timer)
						if (l.progress?.call === callId) l.progress = null
						if (msg.ok) c.resolve(msg.data ?? true)
						else c.reject(new RpcError('BAD_GATEWAY', clip(msg.error, 400) || 'That didn’t work'))
					}
				} catch {
					console.error('[omarchyd] couldn’t handle a connector message')
				}
			})
			const gone = async () => {
				clearInterval(alive)
				if (live.get(a.id)?.ws !== ws) return
				l.progress = null
				live.delete(a.id)
				for (const ch of [...l.channels.values()]) {
					if (ch.kind === 'file') ch.end(new RpcError('BAD_GATEWAY', 'The computer went offline'))
					else closeSocket(ch.ws, 1000, 'The computer went offline')
				}
				for (const c of l.calls.values()) (clearTimeout(c.timer), c.reject(new RpcError('BAD_GATEWAY', 'The computer went offline')))
				a.lastSeen = now()
				await save().catch(() => {})
			}
			ws.on('close', gone)
			ws.on('error', gone)
		})
	}

	// A browser's terminal or desktop viewer, joined to a channel on the computer's connector.
	function openChannel(agentId, kind, browserWs, opts = {}) {
		const a = find(agentId)
		const l = live.get(agentId)
		// Only a terminal or a desktop is a browser socket. A file channel is opened by the server
		// itself (files.pull / files.push). Treating "file" as a desktop would let a browser read it.
		const ability = kind === 'pty' ? 'terminal' : kind === 'vnc' ? 'desktop' : null
		const why = !a ? 'Unknown computer' : !l ? 'That computer is offline' : !ability ? 'That isn’t a terminal or a desktop' : switchedOff(a.name, ability)
		if (!a || !l || !ability || !may(a, ability)) return closeSocket(browserWs, 1011, why)
		const ch = ++l.nextCh
		l.channels.set(ch, {ws: browserWs, kind})
		l.ws.send(JSON.stringify({op: 'open', ch, kind, cols: opts.cols, rows: opts.rows}))
		const head = Buffer.alloc(4)
		head.writeUInt32BE(ch)
		browserWs.on('message', (d, isBinary) => {
			if (l.ws.readyState !== l.ws.OPEN) return
			// A terminal's binary frames are size changes (what's typed is text); the connector
			// resizes its shell. (A desktop's binary frames are the screen's own data.)
			if (kind === 'pty' && isBinary) {
				const size = parseResize(d, true)
				if (size) l.ws.send(JSON.stringify({op: 'resize', ch, cols: size.cols, rows: size.rows}))
				return
			}
			l.ws.send(Buffer.concat([head, Buffer.from(d)]), {binary: true})
		})
		const end = () => {
			if (!l.channels.delete(ch)) return
			if (l.ws.readyState === l.ws.OPEN) l.ws.send(JSON.stringify({op: 'close', ch}))
		}
		browserWs.on('close', end)
		browserWs.on('error', end)
	}

	// A path the connector may open: relative to that computer's home folder. Empty is only "list home".
	function safeHomePath(input, {empty = false} = {}) {
		const raw = String(input ?? '').replace(/\\/g, '/').trim()
		if (raw.startsWith('/') || raw.startsWith('~') || /[\u0000-\u001f\u007f]/.test(raw)) return null
		if (raw === '') return empty ? '' : null
		const parts = raw.split('/').filter((part) => part.length > 0)
		if (!parts.length) return empty ? '' : null
		for (const part of parts) {
			if (part === '.' || part === '..' || part.length > 200) return null
		}
		const path = parts.join('/')
		return path.length > 1024 ? null : path
	}
	function cleanFileRow(row) {
		if (!row || typeof row !== 'object') return null
		const name = typeof row.name === 'string' ? row.name : ''
		if (!name || name.length > 200 || name === '.' || name === '..' || /[\u0000-\u001f\u007f/\\]/.test(name)) return null
		const dir = row.dir === true
		const size = !dir && Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : 0
		const mtime = Number.isSafeInteger(row.mtime) ? row.mtime : null
		return {name, size, mtime, dir}
	}
	async function requireFilesAgent(id) {
		await loaded
		const a = find(String(id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const l = live.get(a.id)
		if (!l) throw new RpcError('PRECONDITION_FAILED', 'That computer is offline right now')
		if (!may(a, 'files')) throw new RpcError('FORBIDDEN', `Add ${a.name} again with Files switched on.`)
		return {a, l}
	}
	// One file transfer on the connector socket. The promise only ever resolves; the caller throws
	// session.failure, so a drop before the first await cannot become an unhandled rejection.
	function openFileSession(l, open, writeChunk) {
		const ch = ++l.nextCh
		let dead = false
		let failure = null
		let result = null
		let meta = null
		let got = 0
		let unacked = 0
		let committed = false
		let chain = Promise.resolve()
		const ackWaiters = []
		let markReady = () => {}
		const ready = new Promise((resolve) => {
			markReady = resolve
		})
		let settle = () => {}
		const settled = new Promise((resolve) => {
			settle = resolve
		})
		const timer = setTimeout(() => finish(new RpcError('BAD_GATEWAY', 'That computer didn’t answer in time')), FILE_MS)
		timer.unref?.()
		const wakeAcks = () => {
			for (const wait of ackWaiters.splice(0)) wait()
		}
		function sendJson(obj) {
			if (l.ws.readyState !== l.ws.OPEN) return false
			try {
				l.ws.send(JSON.stringify(obj))
				return true
			} catch {
				return false
			}
		}
		function finish(err, value) {
			if (dead) return
			dead = true
			clearTimeout(timer)
			l.channels.delete(ch)
			failure = err ?? null
			result = value ?? null
			markReady()
			wakeAcks()
			if (err) sendJson({op: 'close', ch})
			settle()
		}
		async function applyBinary(buf) {
			if (dead) return
			if (open.mode !== 'read') return finish(new RpcError('BAD_GATEWAY', 'That computer sent file bytes it wasn’t asked for'))
			if (!meta || !Number.isSafeInteger(meta.size) || meta.size < 0) return finish(new RpcError('BAD_GATEWAY', 'The file started before its size arrived'))
			if (got + buf.length > meta.size) return finish(new RpcError('BAD_GATEWAY', 'That file is larger than it said'))
			got += buf.length
			await writeChunk(buf)
			if (dead) return
			sendJson({op: 'ack', ch})
		}
		function applyClosed(msg) {
			if (dead) return
			const reason = clip(msg.reason, 200)
			if (msg.code === 1011) return finish(new RpcError('BAD_GATEWAY', reason || 'That computer couldn’t transfer the file'))
			if (open.mode === 'read') {
				if (!meta || !Number.isSafeInteger(meta.size) || got !== meta.size) return finish(new RpcError('BAD_GATEWAY', reason || 'The file changed while it was being read'))
				return finish(null, {size: meta.size, mtime: Number.isSafeInteger(meta.mtime) ? meta.mtime : null})
			}
			if (!committed) return finish(new RpcError('BAD_GATEWAY', reason || 'That computer closed the file early'))
			return finish(null, {size: open.size})
		}
		const channel = {
			kind: 'file',
			end: (err) => finish(err instanceof RpcError ? err : new RpcError('BAD_GATEWAY', 'The computer went offline')),
			onBinary(buf) {
				chain = chain.then(() => applyBinary(buf)).catch((e) => finish(e instanceof RpcError ? e : new RpcError('BAD_GATEWAY', 'Couldn’t transfer that file')))
			},
			onControl(msg) {
				if (msg.op === 'file') {
					meta = msg
					markReady()
					return
				}
				if (msg.op === 'ack') {
					unacked = Math.max(0, unacked - 1)
					wakeAcks()
					return
				}
				if (msg.op === 'closed') chain = chain.then(() => applyClosed(msg)).catch((e) => finish(e instanceof RpcError ? e : new RpcError('BAD_GATEWAY', 'Couldn’t transfer that file')))
			},
		}
		l.channels.set(ch, channel)
		if (!sendJson({op: 'open', ch, ...open})) finish(new RpcError('BAD_GATEWAY', 'The computer went offline'))
		return {
			get failure() {
				return failure
			},
			get result() {
				return result
			},
			get meta() {
				return meta
			},
			ready,
			settled,
			end: channel.end,
			async waitWindow() {
				while (unacked >= FILE_WINDOW && !dead) await new Promise((resolve) => ackWaiters.push(resolve))
			},
			async waitDrained() {
				while (unacked > 0 && !dead) await new Promise((resolve) => ackWaiters.push(resolve))
			},
			noteSent() {
				unacked += 1
			},
			sendFrame(payload) {
				if (l.ws.readyState !== l.ws.OPEN) return false
				const frame = Buffer.alloc(4 + payload.length)
				frame.writeUInt32BE(ch, 0)
				payload.copy(frame, 4)
				try {
					l.ws.send(frame)
					return true
				} catch {
					return false
				}
			},
			sendJson,
			commit() {
				committed = true
				return sendJson({op: 'commit', ch})
			},
		}
	}
	async function statFile(id, path) {
		const rel = safeHomePath(path)
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		const {a} = await requireFilesAgent(id)
		const row = cleanFileRow(await call(a.id, 'files-stat', {path: rel}))
		if (!row) throw new RpcError('BAD_GATEWAY', 'That computer’s answer wasn’t a file')
		return row
	}
	async function listFiles(id, path) {
		const rel = safeHomePath(path ?? '', {empty: true})
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		const {a} = await requireFilesAgent(id)
		const data = await call(a.id, 'files-list', {path: rel})
		const entries = Array.isArray(data?.entries) ? data.entries.slice(0, 200).map(cleanFileRow).filter(Boolean) : []
		return {path: rel, entries, truncated: data?.truncated === true}
	}
	async function pullFile(id, path, writeChunk) {
		const rel = safeHomePath(path)
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		if (typeof writeChunk !== 'function') throw new RpcError('BAD_REQUEST', 'Nowhere to write that file')
		const {l} = await requireFilesAgent(id)
		const session = openFileSession(l, {kind: 'file', mode: 'read', path: rel}, writeChunk)
		await session.ready
		if (session.failure) throw session.failure
		const size = session.meta?.size
		if (!Number.isSafeInteger(size) || size < 0) {
			session.end(new RpcError('BAD_GATEWAY', 'That computer didn’t say how big the file is'))
			throw session.failure
		}
		await session.settled
		if (session.failure) throw session.failure
		return session.result
	}
	async function pushFile(id, path, size, readChunk) {
		if (!Number.isSafeInteger(size) || size < 0) throw new RpcError('BAD_REQUEST', 'That file’s size isn’t usable')
		const rel = safeHomePath(path)
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		if (typeof readChunk !== 'function') throw new RpcError('BAD_REQUEST', 'Nowhere to read that file')
		const {l} = await requireFilesAgent(id)
		const session = openFileSession(l, {kind: 'file', mode: 'write', path: rel, size}, async () => {})
		await session.ready
		if (session.failure) throw session.failure
		if (session.meta?.ready !== true) {
			session.end(new RpcError('BAD_GATEWAY', 'That computer didn’t open the file'))
			throw session.failure
		}
		let sent = 0
		while (sent < size) {
			if (session.failure) throw session.failure
			await session.waitWindow()
			if (session.failure) throw session.failure
			let chunk
			try {
				chunk = await readChunk(Math.min(FILE_CHUNK, size - sent))
			} catch {
				session.end(new RpcError('BAD_GATEWAY', 'Couldn’t read that file'))
				throw session.failure
			}
			const payload = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : null
			if (!payload || payload.length === 0 || payload.length > Math.min(FILE_CHUNK, size - sent)) {
				session.end(new RpcError('BAD_GATEWAY', 'The file arrived short'))
				throw session.failure
			}
			session.noteSent()
			if (!session.sendFrame(payload)) {
				session.end(new RpcError('BAD_GATEWAY', 'The computer went offline'))
				throw session.failure
			}
			sent += payload.length
		}
		await session.waitDrained()
		if (session.failure) throw session.failure
		if (!session.commit()) {
			session.end(new RpcError('BAD_GATEWAY', 'The computer went offline'))
			throw session.failure
		}
		await session.settled
		if (session.failure) throw session.failure
		return session.result
	}

	// For backups.mjs: the computers that may back up, and calls to their connector's backup side.
	const backupCalls = new Set(['backup-folders', 'backup-run', 'backup-restore'])
	const backup = {
		async agents() {
			await loaded
			return state.agents.map((a) => ({id: a.id, name: a.name, online: live.has(a.id), allowed: !!a.allowed.backup, on: may(a, 'backup'), user: a.info?.user ?? '', hostname: a.info?.hostname ?? ''}))
		},
		async call(id, name, args, timeout) {
			await loaded
			const a = find(id)
			if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
			if (!backupCalls.has(name)) throw new RpcError('BAD_REQUEST', 'Unknown action')
			if (!may(a, 'backup')) throw new RpcError('FORBIDDEN', `Backups aren’t switched on for ${a.name}`)
			return call(a.id, name, args, timeout)
		},
		progress: (id) => live.get(id)?.progress ?? null,
		// The backup store's HTTP side: which computer is asking (its own key), if it may back up.
		authenticate(req) {
			const a = authAgent(req)
			return a && may(a, 'backup') ? a.id : null
		},
	}

	const files = {stat: statFile, list: listFiles, pull: pullFile, push: pushFile}

	return {
		files,
		backup,
		procedures: {
			'swarm.list': {kind: 'query', run: list},
			'swarm.pair': {kind: 'mutation', run: pair},
			'swarm.remove': {kind: 'mutation', run: remove},
			'swarm.rename': {kind: 'mutation', run: rename},
			'swarm.setAbilities': {kind: 'mutation', run: setAbilities},
			'swarm.action': {kind: 'mutation', run: action},
			'swarm.storage.status': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, false)
					const storageAllowed = may(a, 'storage')
					if (!storageAllowed) return {helperAvailable: false, zfsAvailable: false, storageAllowed: false}
					try {
						const s = await call(a.id, 'storage-status', {})
						return {helperAvailable: !!s?.helperAvailable, zfsAvailable: !!s?.zfsAvailable, storageAllowed: true}
					} catch (e) {
						if (/allow Storage|doesn’t allow/i.test(e.message)) return {helperAvailable: false, zfsAvailable: false, storageAllowed: false}
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.disks': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						return await call(a.id, 'storage-disks', {})
					} catch (e) {
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.unmount': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-unmount', {device: String(input?.device ?? '')})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.mount': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-mount', {device: String(input?.device ?? '')})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.format': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					const filesystem = String(input?.filesystem ?? '')
					if (!['blank', 'ext4', 'exfat'].includes(filesystem)) throw new RpcError('BAD_REQUEST', 'Choose blank, ext4 or exfat')
					try {
						await call(a.id, 'storage-format', {device: String(input?.device ?? ''), filesystem})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.pools': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						return await call(a.id, 'storage-pools', {})
					} catch (e) {
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.importable': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						return await call(a.id, 'storage-importable', {})
					} catch (e) {
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.createPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-createPool', {
							name: String(input?.name ?? ''),
							fs: input?.fs,
							profile: String(input?.profile ?? ''),
							devices: Array.isArray(input?.devices) ? input.devices.map(String) : [],
						})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.addToPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-addToPool', {name: String(input?.name ?? ''), device: String(input?.device ?? '')})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.importPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-importPool', {name: String(input?.name ?? ''), uuid: String(input?.uuid ?? ''), force: input?.force === true})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.forgetPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-forgetPool', {name: String(input?.name ?? ''), kind: input?.kind})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.scrub': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-scrub', {name: String(input?.name ?? ''), kind: input?.kind})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.setSleep': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-setSleep', {device: String(input?.device ?? ''), minutes: Number(input?.minutes)})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			// Before showing a computer's screen: can it, and if not, why (in words, not a socket code).
			'swarm.desktopCheck': {
				kind: 'query',
				run: async (input) => {
					await loaded
					const a = find(String(input?.id ?? ''))
					if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
					if (!may(a, 'desktop')) throw new RpcError('FORBIDDEN', `Seeing ${a.name}’s desktop isn’t switched on`)
					if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
					const d = a.info?.desktop
					if (d && !d.ok) throw new RpcError('PRECONDITION_FAILED', d.why || 'Its desktop can’t be shown')
					return true
				},
			},
		},
		enroll,
		upgradeAgent,
		openChannel,
		isAgentMachine: (machineId) => /^agent-[0-9a-f]{12}$/.test(machineId),
		close: () => {
			for (const l of live.values()) l.ws.terminate()
		},
	}
}
