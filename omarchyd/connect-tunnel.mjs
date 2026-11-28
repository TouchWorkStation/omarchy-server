// MODC Connect, Phase 5B: run this server's Cloudflare connector (cloudflared) for the tunnel the
// owner set up on myowndatacenter.com. Contract: "MODC Connect — Phase 5A: Secure Tunnel Credential
// Delivery".
//
//   GET  /api/public/cloud/tunnel/status   setup state, connector health, remote access (every 5 min)
//   POST /api/public/cloud/tunnel/token    the cloudflared token (on start, after a rotation, never polled)
//
// Both with the Phase 3 device credential, which connect.mjs owns and hands in on each call.
//
// What runs: one systemd *user* unit of its own, modc-cloudflared.service, as the same person as
// omarchyd (no root, no sudo). It starts cloudflared with an empty environment and only file paths on
// its command line: its own minimal config (no ingress: the tunnel is configured remotely, deny-all) and
// --token-file pointing at <data>/connect/tunnel.token (0600, in a 0700 folder, written atomically).
// The token is never in an argument, an environment variable, a log line or an RPC answer.
//
// Left alone: every other cloudflared service or tunnel on this computer (system or user). This file
// only ever starts, stops, enables, disables or rewrites modc-cloudflared.service.
//
// Never: an ingress rule, a local service exposed, remote access, Cloudflare's own API, or a master
// Cloudflare token. A token answer that says anything but deny-all ingress with remote access off is
// refused and the connector stays off.
import {createHash, randomBytes} from 'node:crypto'
import {execFile} from 'node:child_process'
import {chmod, mkdir, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import os from 'node:os'
import {join} from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {plainObject, readJsonState, writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

export const UNIT = 'modc-cloudflared.service'
// --token-file arrived in cloudflared 2025.4.0.
export const MIN_VERSION = [2025, 4, 0]
// The build installed when this computer has no suitable cloudflared: Cloudflare's own release,
// checked against these SHA-256 sums (of cloudflared-linux-<arch> from the 2026.11.2 GitHub release).
export const PINNED = {
	version: '2026.11.2',
	url: (arch) => `https://github.com/cloudflare/cloudflared/releases/download/2026.11.2/cloudflared-linux-${arch}`,
	sha256: {
		amd64: '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf',
		arm64: '04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281',
	},
	maxBytes: 120 * 1024 * 1024,
}

const STATUS_EVERY_MS = 5 * 60_000 // the contract's suggestion while the connector is on
const STATUS_IDLE_MS = 30 * 60_000 // off: only to show the address and setup state
const STATUS_BLOCKED_MS = 2 * 60_000 // no tunnel, not the connector, deleted tunnel: the owner fixes these on the website, so look again soon (5 of the 30 status calls per 10 minutes)
const STATUS_NOT_ALLOWED_MS = 6 * 60 * 60_000
const AFTER_START_MS = 30_000 // "after about 30 seconds, call status"
const TOKEN_TRIES = 3 // automatic attempts per incident, then the owner presses Try again
const TOKEN_LOCAL_LIMIT = 6 // per hour, under the website's 10
const STUCK_MS = 10 * 60_000 // running but Cloudflare sees nothing: fetch a fresh token, at most hourly
const REQUEST_TIMEOUT_MS = 20_000
const TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,4096}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

// Why the connector is off or unwell, and what the owner can do: shown as written.
export const BLOCKS = {
	no_tunnel: ['No tunnel is set up for this data center yet.', 'Create it in My Data Centers on myowndatacenter.com. This server checks again every 30 minutes, or press Check now.'],
	not_allowed: ['Secure tunnels are in a limited pilot, and your account isn’t in it yet.', 'Nothing to do here; the connector stays off. Pairing and check-ins keep working.'],
	not_connector: ['The website’s tunnel still belongs to an earlier pairing of this data center, so this server isn’t running it yet.', 'On myowndatacenter.com, press Turn on remote access: it moves the tunnel to this server. This server checks again every 2 minutes, or press Check now.'],
	data_center_mismatch: ['This server isn’t attached to that tunnel’s data center.', 'Disconnect, then pair this server with the data center that has the tunnel.'],
	tunnel_missing: ['The tunnel was deleted in Cloudflare.', 'Remove the tunnel on myowndatacenter.com and create it again. The connector stays off until then.'],
	tunnel_mismatch: ['The tunnel no longer matches its record on myowndatacenter.com, so the website refused it.', 'Remove the tunnel on myowndatacenter.com and create it again.'],
	unsafe: ['The website asked for a tunnel setup this version doesn’t recognise, so the connector stays off.', 'Update My Own Data Center, then press Check now.'],
	unprotected: ['Your address is routed to this server, but this server couldn’t confirm that Cloudflare Access is in front of it, so the connector stays off.', 'Check the Access protection for your address on myowndatacenter.com, then press Check now.'],
	token_failed: ['Couldn’t get the tunnel key from myowndatacenter.com after 3 tries.', 'Wait a few minutes, then press Try again.'],
	bad_request: ['The website didn’t accept this server’s tunnel request.', 'Update My Own Data Center, then press Try again.'],
}
const PROVISIONING = {
	provisioning: 'The tunnel is still being set up on myowndatacenter.com.',
	failed: 'Setting up the tunnel failed on myowndatacenter.com. Remove it there and create it again.',
	deleting: 'The tunnel is being removed on myowndatacenter.com.',
}
const CONNECTOR_ERROR = {
	tunnel_missing: 'Cloudflare no longer has this tunnel.',
	tunnel_mismatch: 'The tunnel in Cloudflare doesn’t match the website’s record.',
	cloudflare_permission: 'myowndatacenter.com can’t read the tunnel’s health from Cloudflare right now.',
	cloudflare_error: 'Cloudflare didn’t answer the website’s health check.',
	network: 'myowndatacenter.com couldn’t reach Cloudflare for the health check.',
	unconfigured: 'myowndatacenter.com isn’t set up to check tunnel health right now.',
}

export function parseVersion(text) {
	const m = /(\d{4})\.(\d{1,2})\.(\d{1,3})/.exec(String(text ?? ''))
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
export const versionAtLeast = (v, min = MIN_VERSION) => !!v && (v[0] - min[0] || v[1] - min[1] || v[2] - min[2]) >= 0

function defaultSh(cmd, args, {timeout = 30_000} = {}) {
	return new Promise((resolve) => {
		execFile(cmd, args, {timeout, maxBuffer: 1024 * 1024, env: process.env}, (err, stdout, stderr) => {
			resolve({ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: err?.code === 'ENOENT', out: String(stdout ?? ''), err: String(stderr ?? '')})
		})
	})
}

const archName = () => ({x64: 'amd64', arm64: 'arm64'})[process.arch] ?? null

// The unit file. Every value in it is a path this module chose; no secret, no user text.
export function unitText({bin, config, token}) {
	const q = (p) => `"${String(p).replace(/(["\\])/g, '\\$1')}"`
	return `# Managed by My Own Data Center (MODC Connect). Turned on and off in Settings › MODC Connect.
# Your own cloudflared services and tunnels are separate and are never touched.
[Unit]
Description=MODC Connect tunnel connector (cloudflared)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=10
# No token yet (or wiped): don't start at all, rather than fail and restart over and over.
ConditionFileNotEmpty=${token}

[Service]
Type=simple
# An empty environment: no TUNNEL_* variable from your session can change what this runs.
ExecStart=/usr/bin/env -i HOME=%h PATH=/usr/local/bin:/usr/bin:/bin ${q(bin)} tunnel --no-autoupdate --config ${q(config)} run --token-file ${q(token)}
Restart=on-failure
RestartSec=15
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target
`
}

export const CONFIG_TEXT = `# Managed by My Own Data Center (MODC Connect).
# The tunnel is configured on myowndatacenter.com (deny-all ingress). Nothing is routed from here.
no-autoupdate: true
`

// Remote access through the tunnel ("protected_route") is only accepted when this server sees for
// itself that nothing on it answers a stranger: an unauthenticated request for each of these paths
// must meet a sign-in (Cloudflare Access's, or this server's own gate) or nothing at all. The label
// alone isn't trusted. '/' isn't probed: behind this server's gate it is the public sign-in page.
export const PROBE_PATHS = ['/api/health', '/api/prefs', '/api/rpc/user.get']
// What a stranger's request met, in the same words as the website's checks (modc-v2.ts):
//   access   Cloudflare Access's sign-in          gate     this server's own sign-in gate (401)
//   blocked  nothing: the 404 catch-all of a route that isn't there yet, or the connector not reaching
//            Cloudflare (502/503/504, 52x, 530)
//   exposed  anything else: something answered without a sign-in
// Access and the gate can both be in front for a while when the website switches between them, and a
// new address answers 404 until its route goes live, so all three safe answers are accepted whatever
// the website says is active; only an exposed answer stops the connector.
const BLOCKED_STATUS = new Set([404, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])
export function probeAnswer(res) {
	const loc = res.headers?.get?.('location') ?? ''
	const gate = res.headers?.get?.('x-modc-gate') ?? null
	if ([301, 302, 303, 307, 308].includes(res.status) && isAccessLogin(loc)) return 'access'
	if (res.status === 401 && gate === 'sso_only') return 'gate'
	if (BLOCKED_STATUS.has(res.status) && gate === null) return 'blocked'
	return 'exposed'
}
export const isAccessLogin = (location) => {
	try {
		const u = new URL(location)
		return u.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(u.hostname) && u.pathname.startsWith('/cdn-cgi/access/login')
	} catch {
		return false
	}
}

function validState(v) {
	return plainObject(v)
}

export function createTunnel({
	dir, // <data>/connect
	apiBase,
	credential, // () => the device credential, or null
	onRevoked, // (why) => connect.mjs forgets the credential and stops check-ins
	fetchImpl = fetch,
	sh = defaultSh,
	now = () => Date.now(),
	autoStart = true,
	unitDir = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'systemd', 'user'),
	systemPaths = ['/usr/bin/cloudflared', '/usr/local/bin/cloudflared'],
	arch = archName(),
	log = (m) => console.error(m),
	random = Math.random,
	pinned = PINNED,
}) {
	const base = String(apiBase).replace(/\/+$/, '').replace(/\/api\/public\/cloud$/, '')
	if (!/^https:\/\//.test(base)) throw new Error('MODC Connect needs an https address')
	const stateFile = join(dir, 'tunnel.json')
	const tokenFile = join(dir, 'tunnel.token')
	const configFile = join(dir, 'cloudflared.yml')
	const binDir = join(dir, 'bin')
	const managedBin = join(binDir, 'cloudflared')
	const unitFile = join(unitDir, UNIT)

	// Saved: {enabled, tokenIssuedAt, tunnelId, hostname, dataCenterId, lastHealthyAt, snapshot, block, tokenFetches: [t…]}
	let state = {enabled: false}
	// Not saved: how things are going right now.
	let live = {problem: null, tokenTries: 0, nextAt: null, startedAt: null, installing: false, lastCheckAt: null, binary: null, others: null}
	let timer = null
	let closed = false
	let busy = Promise.resolve()
	const serial = (fn) => {
		const run = busy.then(fn, fn)
		busy = run.catch(() => {})
		return run
	}

	const save = async () => {
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(dir, 0o700)
		await writeAtomic(stateFile, JSON.stringify(state, null, '\t'), {mode: 0o600})
	}

	const ready = (async () => {
		const got = await readJsonState(stateFile, {validate: validState, label: 'connect', log: (m) => log(m)})
		if (got.status === 'ok') state = {enabled: false, ...got.value}
		const st = await stat(tokenFile).catch(() => null)
		if (st && (st.mode & 0o077) !== 0) await chmod(tokenFile, 0o600).catch(() => {})
	})()

	// ---- cloudflared on this computer -------------------------------------------------------------
	async function versionOf(bin) {
		const r = await sh(bin, ['--version'], {timeout: 15_000})
		if (!r.ok) return null
		return parseVersion(r.out || r.err)
	}
	// This server's own copy first (installed from Settings), then the system's, if new enough.
	async function binary(refresh = false) {
		if (live.binary && !refresh) return live.binary
		const found = []
		for (const [path, source] of [[managedBin, 'managed'], ...systemPaths.map((p) => [p, 'system'])]) {
			if (!(await stat(path).catch(() => null))) continue
			const v = await versionOf(path)
			if (v) found.push({path, source, version: v.join('.'), compatible: versionAtLeast(v)})
		}
		const pick = found.find((b) => b.compatible) ?? found[0] ?? null
		live.binary = pick ? {...pick, installed: true} : {installed: false, compatible: false, version: null, source: null}
		return live.binary
	}

	// Download Cloudflare's release for this processor, check its SHA-256, then put it in place.
	async function install() {
		await ready
		if (live.installing) throw new RpcError('CONFLICT', 'cloudflared is already being installed')
		const want = pinned.sha256[arch]
		if (!want) throw new RpcError('PRECONDITION_FAILED', `There’s no cloudflared build for this processor (${process.arch})`)
		live.installing = true
		const tmp = join(binDir, `.cloudflared.${randomBytes(6).toString('hex')}.part`)
		try {
			await mkdir(binDir, {recursive: true, mode: 0o700})
			const res = await fetchImpl(pinned.url(arch), {method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000)}).catch(() => null)
			if (!res?.ok || !res.body) throw new RpcError('BAD_GATEWAY', 'Couldn’t download cloudflared from GitHub. Check this server’s internet connection and try again.')
			const hash = createHash('sha256')
			let size = 0
			const count = new Transform({
				transform(chunk, _e, cb) {
					size += chunk.length
					if (size > pinned.maxBytes) return cb(new Error('too big'))
					hash.update(chunk)
					cb(null, chunk)
				},
			})
			const body = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : res.body
			await pipeline(body, count, createWriteStream(tmp, {mode: 0o700})).catch(() => {
				throw new RpcError('BAD_GATEWAY', 'The cloudflared download didn’t finish. Try again.')
			})
			if (hash.digest('hex') !== want) throw new RpcError('BAD_GATEWAY', 'The downloaded cloudflared didn’t match Cloudflare’s published build, so it wasn’t installed.')
			await chmod(tmp, 0o755)
			const v = await versionOf(tmp)
			if (!versionAtLeast(v)) throw new RpcError('BAD_GATEWAY', 'The downloaded cloudflared didn’t run on this computer.')
			await rename(tmp, managedBin)
			log(`[connect] installed cloudflared ${v.join('.')}`)
			await binary(true)
			return status()
		} finally {
			live.installing = false
			await rm(tmp, {force: true}).catch(() => {})
		}
	}

	// ---- the unit: only ever modc-cloudflared.service ---------------------------------------------
	const ctl = (...args) => sh('systemctl', ['--user', ...args], {timeout: 30_000})
	async function serviceState() {
		const r = await ctl('show', UNIT, '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts', '-p', 'UnitFileState', '-p', 'ActiveEnterTimestamp')
		const kv = Object.fromEntries(
			r.out
				.split('\n')
				.filter((l) => l.includes('='))
				.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
		)
		const since = Date.parse(kv.ActiveEnterTimestamp ?? '')
		return {active: kv.ActiveState ?? 'unknown', sub: kv.SubState ?? '', restarts: Number(kv.NRestarts) || 0, enabled: kv.UnitFileState === 'enabled', since: Number.isFinite(since) ? since : null}
	}
	async function writeUnit(bin) {
		await mkdir(dir, {recursive: true, mode: 0o700})
		await writeAtomic(configFile, CONFIG_TEXT, {mode: 0o600})
		const text = unitText({bin, config: configFile, token: tokenFile})
		const had = await readFile(unitFile, 'utf8').catch(() => null)
		if (had === text) return false
		await mkdir(unitDir, {recursive: true})
		await writeAtomic(unitFile, text, {mode: 0o644})
		await ctl('daemon-reload')
		return true
	}
	async function startService(restart) {
		const bin = await binary(true)
		if (!bin.compatible) {
			live.problem = 'cloudflared'
			return false
		}
		const changed = await writeUnit(bin.path)
		await ctl('enable', UNIT)
		const r = await ctl(restart || changed ? 'restart' : 'start', UNIT)
		live.startedAt = now()
		if (!r.ok) {
			live.problem = 'service'
			log('[connect] the tunnel connector service didn’t start')
			return false
		}
		return true
	}
	async function stopService() {
		const had = await stat(unitFile).catch(() => null)
		if (!had) return
		await ctl('disable', '--now', UNIT)
		live.startedAt = null
	}
	async function removeUnit() {
		await stopService()
		if (await stat(unitFile).catch(() => null)) {
			await rm(unitFile, {force: true})
			await ctl('daemon-reload')
		}
	}
	// Overwrite, then remove: the token doesn't linger in the file's old blocks where that helps.
	async function wipeToken() {
		const st = await stat(tokenFile).catch(() => null)
		if (!st) return
		try {
			const fh = await open(tokenFile, 'r+')
			try {
				await fh.write(Buffer.alloc(st.size, 0), 0, st.size, 0)
				await fh.sync()
			} finally {
				await fh.close()
			}
		} catch {}
		await rm(tokenFile, {force: true})
	}
	async function writeToken(token) {
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(dir, 0o700)
		await writeAtomic(tokenFile, token, {mode: 0o600})
	}
	// Other cloudflared units on this computer, by name only, to say they're left alone.
	async function others() {
		const names = new Set()
		for (const scope of [['--user'], []]) {
			const r = await sh('systemctl', [...scope, 'list-units', '--all', '--plain', '--no-legend', '--type=service', 'cloudflared*'], {timeout: 15_000})
			for (const line of r.out.split('\n')) {
				const name = line.trim().split(/\s+/)[0]
				if (name && name !== UNIT && /^cloudflared[\w@.-]*\.service$/.test(name)) names.add(`${scope.length ? 'user' : 'system'}:${name}`)
			}
		}
		live.others = [...names]
		return live.others
	}

	// ---- myowndatacenter.com ----------------------------------------------------------------------
	async function call(method, path, body) {
		const cred = credential()
		if (!cred) throw Object.assign(new Error('unpaired'), {unpaired: true})
		const headers = {accept: 'application/json', authorization: `Bearer ${cred}`}
		if (body !== undefined) headers['content-type'] = 'application/json'
		let res
		try {
			res = await fetchImpl(`${base}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
		} catch {
			throw Object.assign(new Error('network'), {network: true})
		}
		let parsed = null
		try {
			const text = await res.text()
			parsed = text ? JSON.parse(text) : null
		} catch {}
		const ra = Number(res.headers?.get?.('retry-after'))
		return {status: res.status, body: plainObject(parsed) ? parsed : null, error: plainObject(parsed) ? String(parsed.error ?? '') : '', retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 6 * 3600) : null}
	}

	function schedule(ms) {
		if (timer) clearTimeout(timer)
		timer = null
		live.nextAt = null
		if (closed || !credential()) return
		live.nextAt = now() + ms
		if (!autoStart) return
		timer = setTimeout(() => {
			timer = null
			serial(step).catch((e) => log(`[connect] tunnel check failed: ${e?.message ?? 'error'}`))
		}, ms)
		timer.unref?.()
	}

	// The disconnect procedure (contract §9): stop our connector, wipe the token. Paired or not is the
	// caller's business: a removed tunnel leaves the device paired.
	async function shutDown(block, detail) {
		await stopService()
		await wipeToken()
		state.tokenIssuedAt = null
		state.block = block ? {code: block, at: now(), ...(detail ? {detail: String(detail).slice(0, 200)} : {})} : null
		// What the website said before no longer holds (no tunnel, not this device's, …).
		if (block && block !== 'token_failed' && block !== 'bad_request') state.snapshot = null
		live.tokenTries = 0
		await save()
	}

	// Answers that mean "stop", from either endpoint. Returns true when handled.
	async function handleStop(r) {
		if (r.status === 401) {
			await shutDown(null)
			log('[connect] the website no longer accepts this device; the tunnel connector was stopped')
			// Not awaited: connect.mjs takes its own turn to forget the credential.
			Promise.resolve()
				.then(() => onRevoked?.(r.error || 'invalid_credential'))
				.catch(() => {})
			return true
		}
		if (r.status === 403 || r.status === 404) {
			const code = r.status === 404 ? 'no_tunnel' : ['not_allowed', 'not_connector', 'data_center_mismatch'].includes(r.error) ? r.error : 'not_allowed'
			await shutDown(code)
			schedule(code === 'not_allowed' ? STATUS_NOT_ALLOWED_MS : STATUS_BLOCKED_MS)
			return true
		}
		if (r.status === 409 && (r.error === 'tunnel_missing' || r.error === 'tunnel_mismatch')) {
			await shutDown(r.error)
			schedule(STATUS_BLOCKED_MS)
			return true
		}
		return false
	}

	// -> {ok: true, seen} | {ok: false, code: 'unprotected', detail} | {ok: false, code: 'unverified', detail}
	async function probeSafe(hostname) {
		const seen = new Set()
		for (const path of PROBE_PATHS) {
			let res
			try {
				res = await fetchImpl(`https://${hostname}${path}`, {method: 'GET', redirect: 'manual', headers: {accept: 'application/json'}, signal: AbortSignal.timeout(15_000)})
			} catch {
				return {ok: false, code: 'unverified', detail: `couldn’t reach https://${hostname}${path}`}
			}
			res.body?.cancel?.().catch?.(() => {})
			const answer = probeAnswer(res)
			if (answer === 'exposed') return {ok: false, code: 'unprotected', detail: `${path} answered HTTP ${res.status} without asking anyone to sign in`}
			seen.add(answer)
		}
		return {ok: true, seen: [...seen].sort()}
	}
	// Is what the website set up for this tunnel acceptable to run? Checked on every status read.
	async function ingressPolicy(snap) {
		if (snap.ingress === 'deny_all' && snap.remoteAccess !== true) return {ok: true, mode: 'deny_all'}
		// The security contract, when present, must name Cloudflare Access (v1); then this server checks it.
		const ssoOnly = snap.protectionMode === 'modc_sso' && snap.contractVersion === 2
		const contractOk = snap.protectionMode == null || (snap.protectionMode === 'cloudflare_access' && snap.contractVersion === 1) || ssoOnly
		if (snap.ingress === 'protected_route' && snap.remoteAccess === true && snap.remoteState === 'enabled' && snap.hostname && contractOk) {
			const p = await probeSafe(snap.hostname)
			return p.ok ? {ok: true, mode: 'protected_route', hostname: snap.hostname, at: now(), seen: p.seen} : p
		}
		return {ok: false, code: 'unsafe', detail: `ingress “${snap.ingress ?? 'none'}”, remote access ${snap.remoteAccess === true ? 'on' : 'off'}`}
	}

	const backoff = (tries, retryAfter, baseMs) => Math.max((retryAfter ?? 0) * 1000, baseMs * 2 ** Math.max(0, tries - 1) * (0.8 + 0.4 * random()))

	async function fetchToken() {
		// Under the website's limit (10 an hour) whatever happens here.
		const hourAgo = now() - 3600_000
		state.tokenFetches = (state.tokenFetches ?? []).filter((t) => t > hourAgo)
		if (state.tokenFetches.length >= TOKEN_LOCAL_LIMIT) {
			live.problem = 'token_wait'
			schedule(state.tokenFetches[0] + 3600_000 - now() + 1000)
			return false
		}
		state.tokenFetches.push(now())
		live.tokenTries += 1
		let r
		try {
			r = await call('POST', '/api/public/cloud/tunnel/token', {})
		} catch (e) {
			if (e.unpaired) return false
			return retryToken(null, 30_000)
		}
		if (r.status === 200) {
			const b = r.body ?? {}
			const shapeOk = b.token_type === 'cloudflared_tunnel_token' && typeof b.tunnel_token === 'string' && TOKEN_RE.test(b.tunnel_token) && UUID.test(String(b.tunnel_id)) && HOST_RE.test(String(b.hostname))
			if (!shapeOk) return retryToken(null, 60_000)
			const denyAll = b.ingress === 'deny_all' && b.remote_access === false
			// A protected route only right after this server checked Access guards that same address.
			const protectedOk = b.ingress === 'protected_route' && b.remote_access === true && live.policy?.ok && live.policy.mode === 'protected_route' && live.policy.hostname === String(b.hostname).toLowerCase()
			if (!denyAll && !protectedOk) {
				await shutDown('unsafe', `token answer: ingress “${String(b.ingress ?? 'none').slice(0, 40)}”`)
				log('[connect] refused a tunnel setup that wasn’t checked')
				return false
			}
			await writeToken(b.tunnel_token)
			const issued = Date.parse(b.issued_at)
			state.tokenIssuedAt = Number.isFinite(issued) ? issued : now()
			state.tunnelId = b.tunnel_id
			state.hostname = b.hostname
			if (UUID.test(String(b.data_center_id))) state.dataCenterId = b.data_center_id
			state.block = null
			live.tokenTries = 0
			live.problem = null
			await save()
			log('[connect] got the tunnel key')
			return true
		}
		if (await handleStop(r)) return false
		if (r.status === 409 && r.error === 'tunnel_busy') return retryToken(r.retryAfter, 90_000)
		if (r.status === 409) return retryToken(r.retryAfter, 120_000) // tunnel_not_ready
		if (r.status === 429 || r.status >= 500) return retryToken(r.retryAfter, 60_000)
		await shutDown('bad_request')
		return false
	}
	async function retryToken(retryAfter, baseMs) {
		await save()
		if (live.tokenTries >= TOKEN_TRIES) {
			live.problem = null
			state.block = {code: 'token_failed', at: now()}
			await save()
			schedule(STATUS_EVERY_MS)
			return false
		}
		live.problem = 'token_retry'
		schedule(backoff(live.tokenTries, retryAfter, baseMs))
		return false
	}

	// One check: what the website says, then bring this computer in line with it.
	async function step() {
		if (closed || !credential()) return
		live.lastCheckAt = now()
		live.nextAt = null
		let r
		try {
			r = await call('GET', '/api/public/cloud/tunnel/status')
		} catch (e) {
			if (e.unpaired) return
			// Offline or the website is down: leave a running connector as it is.
			live.problem = 'offline'
			return schedule(state.enabled ? STATUS_EVERY_MS : STATUS_IDLE_MS)
		}
		if (r.status === 429) {
			live.problem = 'rate_limited'
			return schedule(Math.max(60_000, (r.retryAfter ?? 60) * 1000))
		}
		if (await handleStop(r)) return
		if (r.status !== 200 || !r.body) {
			live.problem = 'unavailable'
			return schedule(state.enabled ? STATUS_EVERY_MS : STATUS_IDLE_MS)
		}
		live.problem = null
		const snap = snapshot(r.body)
		state.snapshot = snap
		if (snap.hostname) state.hostname = snap.hostname
		if (snap.healthy && state.enabled) state.lastHealthyAt = now()
		const policy = await ingressPolicy(snap)
		live.policy = policy
		if (!policy.ok && policy.code === 'unverified') {
			// Can't confirm the protection right now (no internet?): run nothing remote-reachable until we can.
			live.problem = 'protection_unverified'
			await stopService()
			await save()
			return schedule(STATUS_EVERY_MS)
		}
		if (!policy.ok) {
			await shutDown(policy.code, policy.detail)
			return schedule(STATUS_EVERY_MS)
		}
		// Checked and fine now: an earlier block about the setup no longer applies.
		if (state.block && state.block.code !== 'token_failed') state.block = null
		await save()

		if (!state.enabled) {
			await stopService()
			return schedule(STATUS_IDLE_MS)
		}
		if (snap.provisioning !== 'active') {
			// Being set up, failed or being removed: nothing to run yet.
			if (snap.provisioning === 'deleting') await shutDown(null)
			return schedule(STATUS_EVERY_MS)
		}
		if (state.block?.code === 'token_failed') return schedule(STATUS_EVERY_MS)

		const haveToken = !!(await stat(tokenFile).catch(() => null)) && !!state.tokenIssuedAt
		const rotated = snap.rotatedAt && state.tokenIssuedAt && snap.rotatedAt > state.tokenIssuedAt
		const svc = await serviceState()
		const stuck = svc.active === 'active' && !snap.healthy && live.startedAt && now() - live.startedAt > STUCK_MS && (!state.tokenIssuedAt || now() - state.tokenIssuedAt > 3600_000)
		if (!haveToken || rotated || stuck) {
			// Startup, a rotation (the old token no longer works), or Cloudflare never saw it connect.
			if (rotated) log('[connect] the tunnel’s credentials were rotated; getting the new key')
			if (!(await fetchToken())) {
				if (!live.nextAt) schedule(STATUS_EVERY_MS)
				return
			}
			await startService(true)
			return schedule(AFTER_START_MS)
		}
		if (svc.active !== 'active' && svc.active !== 'activating') {
			await startService(false)
			return schedule(AFTER_START_MS)
		}
		if (!live.startedAt) live.startedAt = svc.since ?? now()
		return schedule(STATUS_EVERY_MS)
	}

	function snapshot(b) {
		const p = plainObject(b.provisioning) ? b.provisioning : {}
		const c = plainObject(b.connector) ? b.connector : {}
		const ra = plainObject(b.remote_access) ? b.remote_access : {}
		const cr = plainObject(b.credentials) ? b.credentials : {}
		const health = ['healthy', 'degraded', 'down', 'inactive', 'unknown'].includes(c.health) ? c.health : 'unknown'
		const t = (v) => {
			const n = Date.parse(v)
			return Number.isFinite(n) ? n : null
		}
		return {
			checkedAt: t(b.checked_at) ?? now(),
			provisioning: ['provisioning', 'active', 'failed', 'deleting'].includes(p.status) ? p.status : 'unknown',
			hostname: HOST_RE.test(String(p.hostname ?? '')) ? String(p.hostname).toLowerCase() : null,
			provisionedAt: t(p.provisioned_at),
			health,
			healthy: health === 'healthy' || health === 'degraded',
			connections: Number.isInteger(c.connections) && c.connections >= 0 ? c.connections : 0,
			colos: Array.isArray(c.colos) ? c.colos.filter((x) => typeof x === 'string' && /^[a-z0-9-]{2,12}$/i.test(x)).slice(0, 8) : [],
			clientVersion: typeof c.client_version === 'string' && c.client_version.length <= 40 ? c.client_version : null,
			connectedSince: t(c.connected_since),
			connectorError: typeof c.error === 'string' && CONNECTOR_ERROR[c.error] ? c.error : null,
			remoteAccess: ra.enabled === true ? true : ra.enabled === false ? false : null,
			remoteState: typeof ra.state === 'string' ? ra.state.slice(0, 40) : null,
			// The versioned security contract (handoff §11), when the website sends it.
			protectionMode: plainObject(ra.security) && typeof ra.security.protection_mode === 'string' ? ra.security.protection_mode : null,
			contractVersion: plainObject(ra.security) ? ra.security.contract_version : null,
			ingress: typeof ra.ingress === 'string' ? ra.ingress : null,
			rotatedAt: t(cr.secret_rotated_at),
			rotationRequired: cr.rotation_required === true,
			lastTokenIssuedAt: t(cr.last_token_issued_at),
		}
	}

	// ---- What Settings sees. No token, no credential, no path. -------------------------------------
	async function status() {
		const bin = live.binary ?? (await binary())
		const svc = (await stat(unitFile).catch(() => null)) ? await serviceState() : {active: 'inactive', sub: '', restarts: 0, enabled: false, since: null}
		const s = state.snapshot ?? null
		const block = state.block && BLOCKS[state.block.code] ? {code: state.block.code, message: BLOCKS[state.block.code][0], recovery: BLOCKS[state.block.code][1], detail: state.block.detail ?? null, at: state.block.at} : null
		let health = s?.health ?? null
		// Just started: Cloudflare takes a little while to see it.
		const connecting = state.enabled && svc.active === 'active' && !s?.healthy && live.startedAt && now() - live.startedAt < 3 * 60_000
		return {
			enabled: !!state.enabled,
			hostname: state.hostname ?? s?.hostname ?? null,
			provisioning: s?.provisioning ?? null,
			provisioningNote: s && PROVISIONING[s.provisioning] ? PROVISIONING[s.provisioning] : null,
			health: connecting ? 'connecting' : health,
			connections: s?.connections ?? 0,
			colos: s?.colos ?? [],
			connectedSince: s?.connectedSince ?? null,
			connectorError: s?.connectorError ? CONNECTOR_ERROR[s.connectorError] : null,
			lastHealthyAt: state.lastHealthyAt ?? null,
			checkedAt: s?.checkedAt ?? null,
			// What the website set up, and whether this server confirmed Access guards it.
			remoteAccess: s?.remoteAccess === true,
			ingress: s?.ingress ?? 'deny_all',
			accessVerified: live.policy?.ok === true && live.policy.mode === 'protected_route',
			rotatedAt: s?.rotatedAt ?? null,
			rotationRequired: s?.rotationRequired ?? false,
			tokenIssuedAt: state.tokenIssuedAt ?? null,
			block,
			problem: live.problem,
			nextCheckAt: live.nextAt,
			cloudflared: {installed: bin.installed, version: bin.version, compatible: bin.compatible, source: bin.source, installable: !!pinned.sha256[arch], pinnedVersion: pinned.version, minimum: MIN_VERSION.join('.'), installing: live.installing},
			service: {state: svc.active, since: svc.since, restarts: svc.restarts, failing: svc.active === 'failed' || svc.restarts >= 5, running: svc.active === 'active' || svc.active === 'activating'},
			others: live.others ?? [],
		}
	}

	async function enable() {
		await ready
		return serial(async () => {
			if (!credential()) throw new RpcError('PRECONDITION_FAILED', 'Connect this server to myowndatacenter.com first')
			const bin = await binary(true)
			if (!bin.compatible) throw new RpcError('PRECONDITION_FAILED', bin.installed ? `This computer’s cloudflared (${bin.version}) is too old. Install the newer one here.` : 'Install cloudflared first')
			state.enabled = true
			delete state.ownerOff
			if (state.block?.code === 'token_failed' || state.block?.code === 'bad_request') state.block = null
			live.tokenTries = 0
			await save()
			await others()
			await step()
			return status()
		})
	}
	async function disable() {
		await ready
		return serial(async () => {
			state.enabled = false
			// Turned off on purpose (by the owner, or by remote access's emergency stop): pairing again
			// doesn't turn it back on by itself.
			state.ownerOff = true
			await removeUnit()
			await wipeToken()
			state.tokenIssuedAt = null
			live.problem = null
			await save()
			schedule(STATUS_IDLE_MS)
			return status()
		})
	}
	async function check() {
		await ready
		return serial(async () => {
			// The status endpoint allows 30 per 10 minutes; a button pressed again and again stays under it.
			if (!credential()) throw new RpcError('PRECONDITION_FAILED', 'Connect this server to myowndatacenter.com first')
			if (live.lastCheckAt && now() - live.lastCheckAt < 15_000) throw new RpcError('TOO_MANY_REQUESTS', `Checked ${Math.round((now() - live.lastCheckAt) / 1000)} seconds ago. Try again in a few seconds.`)
			if (state.block?.code === 'token_failed' || state.block?.code === 'bad_request' || state.block?.code === 'unsafe' || state.block?.code === 'unprotected') state.block = null
			live.tokenTries = 0
			await binary(true)
			await others()
			await step()
			return status()
		})
	}
	// The device is gone (revoked, disconnected, reset): stop everything and forget it all.
	async function teardown() {
		await ready
		return serial(async () => {
			await removeUnit()
			await wipeToken()
			state = {enabled: false}
			live = {...live, problem: null, tokenTries: 0, startedAt: null}
			if (timer) clearTimeout(timer)
			timer = null
			live.nextAt = null
			await save()
		})
	}
	// Pairing is the owner's yes to connecting, so the connector turns on by itself (downloading the
	// pinned, checksum-verified cloudflared if this computer has none), unless it was turned off on
	// purpose. Turning on only allows it to run: the website's state and this server's own probe of its
	// address still decide, on every check, whether it runs.
	async function autoEnable() {
		await ready
		if (!credential() || state.enabled || state.ownerOff) return null
		try {
			const bin = await binary(true)
			if (!bin.compatible) await install()
			const s = await enable()
			log('[connect] the connector turned on by itself after pairing')
			return s
		} catch (e) {
			log(`[connect] the connector couldn’t turn on by itself (${String(e?.message ?? e).slice(0, 120)}); turn it on in Settings → MODC Connect`)
			return null
		}
	}
	// omarchyd started: line things up again (the unit itself already starts at boot when enabled).
	async function begin(delay = 10_000) {
		await ready
		if (!credential()) {
			// Not paired any more but a connector is set up: it must not keep running.
			if (state.enabled || (await stat(unitFile).catch(() => null))) await teardown()
			return
		}
		schedule(delay)
	}

	return {
		ready,
		status: async () => (await ready, status()),
		enable,
		disable,
		autoEnable,
		check,
		install,
		teardown,
		begin,
		tick: async () => (await ready, serial(step)),
		files: {tokenFile, unitFile, configFile, managedBin},
		close() {
			closed = true
			if (timer) clearTimeout(timer)
			timer = null
		},
	}
}
