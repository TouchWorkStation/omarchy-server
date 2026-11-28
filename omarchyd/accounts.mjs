// Accounts and sessions. Passwords are scrypt-hashed; tokens are random and held server-side only.
// The owner account is created on the server itself (`omarchyd create-owner`), never over the web.
import {createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {chmod, mkdir, readFile, stat} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'

import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

const scrypt = promisify(scryptCb)
const token = (prefix = '') => prefix + randomBytes(32).toString('base64url')
const ACCESS_TTL = 60 * 60 * 1000
const DEVICE_TTL = 90 * 24 * 60 * 60 * 1000
const BROWSER_TTL = 7 * 24 * 60 * 60 * 1000
const URL_TOKEN_TTL = 60 * 60 * 1000

async function hashPassword(password, salt = randomBytes(16)) {
	const hash = await scrypt(password, salt, 64, {N: 16384, r: 8, p: 1})
	return {salt: salt.toString('base64'), hash: hash.toString('base64')}
}
// ---- two-factor codes (TOTP, RFC 6238: 30-second, 6-digit, SHA-1, as authenticator apps expect) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32 = (buf) => {
	let bits = 0
	let value = 0
	let out = ''
	for (const byte of buf) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31]
	return out
}
const unbase32 = (text) => {
	const clean = String(text).toUpperCase().replace(/[=\s]/g, '')
	if (!/^[A-Z2-7]{16,128}$/.test(clean)) return null
	let bits = 0
	let value = 0
	const out = []
	for (const c of clean) {
		value = (value << 5) | B32.indexOf(c)
		bits += 5
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255)
			bits -= 8
		}
	}
	return Buffer.from(out)
}
export function totpCode(secret, time = Date.now(), step = 0) {
	const counter = Buffer.alloc(8)
	counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000) + step))
	const mac = createHmac('sha1', secret).update(counter).digest()
	const offset = mac[mac.length - 1] & 15
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
// One step either side, for clocks that are a little off. Returns the matching time step (or null).
const totpStep = (secret, token) => {
	if (!/^\d{6}$/.test(String(token ?? ''))) return null
	for (const s of [-1, 0, 1]) if (timingSafeEqual(Buffer.from(totpCode(secret, Date.now(), s)), Buffer.from(String(token)))) return Math.floor(Date.now() / 30_000) + s
	return null
}
const totpOk = (secret, token) => totpStep(secret, token) !== null
export const secretFromUri = (uri) => {
	try {
		const u = new URL(String(uri))
		return u.protocol === 'otpauth:' ? unbase32(u.searchParams.get('secret') ?? '') : null
	} catch {
		return null
	}
}

async function checkPassword(password, user) {
	const {hash} = await hashPassword(password, Buffer.from(user.salt, 'base64'))
	const a = Buffer.from(hash, 'base64')
	const b = Buffer.from(user.hash, 'base64')
	return a.length === b.length && timingSafeEqual(a, b)
}

// null and arrays are not plain objects. JSON values have no other prototypes.
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function accountsObject(value) {
	if (!plainObject(value) || !Array.isArray(value.users)) return false
	if ('devices' in value && !plainObject(value.devices)) return false
	if ('browsers' in value && !plainObject(value.browsers)) return false
	return true
}

// The message names the file and nothing else, so a log cannot leak the path or a totp secret.
const damagedAccounts = () => new Error('accounts.json is damaged or unreadable')

export async function openAccounts(dataDir, {create = true} = {}) {
	if (create) {
		await mkdir(dataDir, {recursive: true, mode: 0o700})
	} else {
		const st = await stat(dataDir).catch((error) => {
			if (error?.code === 'ENOENT') return null
			throw error
		})
		if (st && !st.isDirectory()) throw Object.assign(new Error('not a directory'), {code: 'ENOTDIR'})
		if (!st) return {hasOwner: () => false}
	}
	const file = join(dataDir, 'accounts.json')
	let raw = null
	try {
		raw = await readFile(file, 'utf8')
	} catch (error) {
		// Only a missing file means there is no owner yet. Any other read error must not
		// look like an empty server, or createOwner would save over the real accounts.
		if (error?.code !== 'ENOENT') throw damagedAccounts()
	}
	let state = {users: [], devices: {}, browsers: {}}
	if (raw !== null) {
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			throw damagedAccounts()
		}
		if (!accountsObject(parsed)) throw damagedAccounts()
		state = {...state, ...parsed}
	}
	// Short-lived tokens stay in memory; device and browser sessions survive restarts.
	const access = new Map() // accessToken -> {userId, sessionId, expiresAt}
	const urlTokens = new Map() // url token -> {browserToken, expiresAt}
	let saving = Promise.resolve()
	// One write at a time. A failed write is reported to its caller only: the next save starts fresh.
	// `snapshot` is what gets written. Callers that must not publish a change until it is durable
	// pass a copy and assign `state` only after this resolves.
	const save = (snapshot = state) => {
		const next = saving.then(async () => {
			await writeAtomic(file, JSON.stringify(snapshot, null, '\t'))
			await chmod(file, 0o600).catch(() => {})
		})
		saving = next.catch(() => {})
		return next
	}
	// One change at a time, each built from the accounts as they are when its turn comes, so two
	// changes made together both stick. `change` is a function of the current state (or a new state).
	let committing = Promise.resolve()
	const commit = (change) => {
		const run = committing.then(async () => {
			const snapshot = typeof change === 'function' ? change(state) : change
			await save(snapshot)
			state = snapshot
		})
		committing = run.catch(() => {})
		return run
	}
	const now = () => Date.now()
	const prune = () => {
		for (const [k, v] of access) if (v.expiresAt < now()) access.delete(k)
		for (const [k, v] of urlTokens) if (v.expiresAt < now()) urlTokens.delete(k)
		for (const [k, v] of Object.entries(state.devices)) if (v.expiresAt < now()) delete state.devices[k]
		for (const [k, v] of Object.entries(state.browsers)) if (v.expiresAt < now()) delete state.browsers[k]
	}
	// No owner in this process yet: create-owner (or the step after a reset) may have written
	// the file from another process. Once an owner is loaded, do not read again — that would
	// drop devices and browser sessions that exist only in this process.
	const adoptOwnerFromDisk = () => {
		if (state.users.length > 0) return
		let raw
		try {
			raw = readFileSync(file, 'utf8')
		} catch (error) {
			if (error?.code === 'ENOENT') return
			throw damagedAccounts()
		}
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			throw damagedAccounts()
		}
		if (!accountsObject(parsed)) throw damagedAccounts()
		if (parsed.users.length === 0) return
		state = {users: [], devices: {}, browsers: {}, ...parsed}
	}
	const userById = (id) => {
		adoptOwnerFromDisk()
		return state.users.find((u) => u.userId === id)
	}
	const publicUser = (u) => ({userId: u.userId, name: u.name, role: u.role, language: u.language ?? 'en', wallpaper: u.wallpaper ?? {id: 'omarchy'}})

	// Guessing passwords: checks for an account run one at a time, and after a few wrong ones each
	// further try waits longer (up to 30 s). Nobody is ever locked out, but guessing becomes far too
	// slow to work, whoever asks: the web app, or any program on this server.
	const failures = new Map() // userId -> [times]
	const queues = new Map() // userId -> promise of the check in progress
	const usedSteps = new Map() // userId -> last 2FA time step used (a code works once)
	async function verify(input, opts) {
		adoptOwnerFromDisk()
		const key = input?.userId ?? state.users[0]?.userId ?? '-'
		const prev = queues.get(key) ?? Promise.resolve()
		const run = prev.catch(() => {}).then(async () => {
			const recent = (failures.get(key) ?? []).filter((t) => now() - t < 15 * 60_000)
			failures.set(key, recent)
			if (recent.length >= 5) await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** (recent.length - 5))))
			try {
				return await check(input, opts)
			} catch (error) {
				if (error instanceof RpcError && error.code === 'UNAUTHORIZED' && !/^Enter the 6-digit/.test(error.message)) failures.set(key, [...(failures.get(key) ?? []), now()])
				throw error
			}
		})
		queues.set(key, run)
		try {
			const user = await run
			failures.delete(key)
			return user
		} finally {
			if (queues.get(key) === run) queues.delete(key)
		}
	}
	async function check({userId, password, totpToken}, {twoFactor = true} = {}) {
		adoptOwnerFromDisk()
		const user = userId ? userById(userId) : state.users[0]
		if (!user || typeof password !== 'string' || !(await checkPassword(password, user))) {
			await new Promise((r) => setTimeout(r, 300 + Math.random() * 300))
			throw new RpcError('UNAUTHORIZED', 'Incorrect password')
		}
		// Signing in also needs the authenticator code when two-factor is on.
		if (twoFactor && user.totp) {
			if (!totpToken) throw new RpcError('UNAUTHORIZED', 'Enter the 6-digit code from your authenticator app (2FA)')
			const step = totpStep(Buffer.from(user.totp, 'base64'), totpToken)
			if (step === null || step <= (usedSteps.get(user.userId) ?? -1)) {
				await new Promise((r) => setTimeout(r, 300 + Math.random() * 300))
				throw new RpcError('UNAUTHORIZED', step === null ? 'That 2FA code isn’t right. Try the current one.' : 'That 2FA code was already used. Wait for the next one.')
			}
			usedSteps.set(user.userId, step)
		}
		return user
	}
	async function issueBrowser(userId) {
		prune()
		const bearer = token('bt_')
		const cookie = token()
		state.browsers[bearer] = {userId, cookie, sessionId: token('s_'), createdAt: now(), expiresAt: now() + BROWSER_TTL}
		await save()
		return {bearer, cookie, userId}
	}
	function issueAccess(userId, sessionId) {
		const accessToken = token('at_')
		const accessExpiresAt = now() + ACCESS_TTL
		access.set(accessToken, {userId, sessionId, expiresAt: accessExpiresAt})
		return {accessToken, accessExpiresAt}
	}

	return {
		hasOwner: () => {
			adoptOwnerFromDisk()
			return state.users.length > 0
		},
		async createOwner({name, password}) {
			adoptOwnerFromDisk()
			if (state.users.length) throw new Error('An owner account already exists')
			const clean = String(name ?? '').trim()
			if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(clean)) throw new Error('Use 1-40 letters, numbers, spaces, dots, dashes or underscores for the name')
			if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password of at least 8 characters')
			const hashed = await hashPassword(password)
			await commit((s) => {
				if (s.users.length) throw new Error('An owner account already exists')
				return {...s, users: [...s.users, {userId: 'owner', name: clean, role: 'owner', language: 'en', ...hashed, createdAt: now()}]}
			})
		},
		async setPassword(userId, {oldPassword, newPassword}) {
			const user = await verify({userId, password: oldPassword}, {twoFactor: false})
			if (typeof newPassword !== 'string' || newPassword.length < 8) throw new RpcError('BAD_REQUEST', 'Use a password of at least 8 characters')
			const hashed = await hashPassword(newPassword)
			// A new password signs out every other session, but only once the file is saved.
			await commit((s) => ({
				...s,
				users: s.users.map((u) => (u.userId === user.userId ? {...u, ...hashed} : u)),
				devices: {},
				browsers: {},
			}))
			access.clear()
		},
		// A forgotten password, set from a terminal on the server (`omarchyd reset-password`), so no old
		// password is asked. Every session is signed out. Two-factor stays as it is.
		async resetPassword({name, newPassword} = {}) {
			adoptOwnerFromDisk()
			const wanted = name === undefined ? null : String(name).trim().toLowerCase()
			const user = wanted === null ? state.users.find((u) => u.role === 'owner') : state.users.find((u) => u.name.toLowerCase() === wanted)
			if (!user) throw new Error(wanted === null ? 'There is no owner account yet. Create one with create-owner.' : `There is no account named “${name}”.`)
			if (typeof newPassword !== 'string' || newPassword.length < 8) throw new Error('Use a password of at least 8 characters')
			const hashed = await hashPassword(newPassword)
			await commit((s) => ({...s, users: s.users.map((u) => (u.userId === user.userId ? {...u, ...hashed} : u)), devices: {}, browsers: {}}))
			access.clear()
			return {name: user.name, twoFactor: !!user.totp}
		},
		// Asked again before sensitive actions (signing in the desktop).
		confirmPassword: async (userId, password) => (await verify({userId, password}, {twoFactor: false}), true),
		// Username plus password, and the authenticator code when it is on. An unknown name does not fall back to the owner.
		async verifyCredentials({username, password, totpToken} = {}) {
			adoptOwnerFromDisk()
			const needle = String(username ?? '').trim()
			const lower = needle.toLowerCase()
			const match = needle ? state.users.find((u) => u.userId === needle || u.name.toLowerCase() === lower) : null
			if (!match) {
				await new Promise((r) => setTimeout(r, 300 + Math.random() * 300))
				throw new RpcError('UNAUTHORIZED', 'Incorrect username or password')
			}
			try {
				const user = await verify({userId: match.userId, password, totpToken}, {twoFactor: true})
				return publicUser(user)
			} catch (e) {
				if (e instanceof RpcError && e.code === 'UNAUTHORIZED' && e.message === 'Incorrect password') {
					throw new RpcError('UNAUTHORIZED', 'Incorrect username or password')
				}
				throw e
			}
		},
		// ---- two-factor ----
		is2faEnabled: (userId) => !!userById(userId)?.totp,
		totpUri(userId) {
			const u = userById(userId)
			const label = encodeURIComponent(`MODC:${u?.name ?? 'owner'}`)
			return `otpauth://totp/${label}?secret=${base32(randomBytes(20))}&issuer=${encodeURIComponent('MODC')}&algorithm=SHA1&digits=6&period=30`
		},
		async enable2fa(userId, {totpUri, totpToken} = {}) {
			const u = userById(userId)
			const secret = secretFromUri(totpUri)
			if (!u || !secret) throw new RpcError('BAD_REQUEST', 'Scan the code again')
			if (!totpOk(secret, totpToken)) throw new RpcError('BAD_REQUEST', 'That code isn’t right. Enter the one your app shows now.')
			await commit((s) => ({...s, users: s.users.map((user) => (user.userId === u.userId ? {...user, totp: secret.toString('base64')} : user))}))
		},
		async disable2fa(userId, {totpToken} = {}) {
			const u = userById(userId)
			if (!u?.totp) return
			if (!totpOk(Buffer.from(u.totp, 'base64'), totpToken)) throw new RpcError('BAD_REQUEST', 'That code isn’t right. Enter the one your app shows now.')
			await commit((s) => ({...s, users: s.users.map((user) => {
				if (user.userId !== u.userId) return user
				const {totp: _totp, ...rest} = user
				return rest
			})}))
		},
		// Factory reset: every account and sign-in goes; the next visit starts first-time setup.
		async reset() {
			await commit({users: [], devices: {}, browsers: {}})
			access.clear()
			urlTokens.clear()
		},
		listAccounts: () => {
			adoptOwnerFromDisk()
			return state.users.map(publicUser)
		},
		getUser: (userId) => {
			const u = userById(userId)
			return u ? publicUser(u) : null
		},
		async updateUser(userId, patch) {
			const u = userById(userId)
			if (!u) throw new RpcError('NOT_FOUND', 'No such account')
			await commit((s) => ({
				...s,
				users: s.users.map((user) => {
					if (user.userId !== u.userId) return user
					const nextUser = {...user}
					if (typeof patch?.name === 'string' && patch.name.trim()) nextUser.name = [...patch.name.trim()].slice(0, 40).join('')
					if (typeof patch?.language === 'string') nextUser.language = patch.language.slice(0, 10)
					if (typeof patch?.wallpaper === 'string') nextUser.wallpaper = {id: patch.wallpaper.slice(0, 40)}
					return nextUser
				}),
			}))
		},

		// Native login: a short access token plus a long-lived device token to refresh it.
		async loginNative(input) {
			const user = await verify(input ?? {})
			if (!input?.client?.id) throw new RpcError('BAD_REQUEST', 'Missing client')
			prune()
			const sessionId = token('s_')
			const deviceToken = token('dt_')
			state.devices[deviceToken] = {userId: user.userId, sessionId, client: String(input.client.id).slice(0, 60), createdAt: now(), expiresAt: now() + DEVICE_TTL}
			await save()
			return {accountId: user.userId, ...issueAccess(user.userId, sessionId), deviceToken}
		},
		// MODC Connect single sign-on: a native session for an account the website already vouched for
		// (connect-sso.mjs checks the website, the device and the pinned owner account first).
		async loginNativeFor(userId, client) {
			const user = userById(userId)
			if (!user) throw new RpcError('UNAUTHORIZED', 'No such account')
			prune()
			const sessionId = token('s_')
			const deviceToken = token('dt_')
			state.devices[deviceToken] = {userId: user.userId, sessionId, client: String(client).slice(0, 60), createdAt: now(), expiresAt: now() + DEVICE_TTL}
			await save()
			return {accountId: user.userId, ...issueAccess(user.userId, sessionId), deviceToken}
		},
		// End one native session by its device token (SSO session expired or revoked).
		async logoutDevice(deviceToken) {
			const d = typeof deviceToken === 'string' ? state.devices[deviceToken] : null
			if (!d) return
			for (const [k, v] of Object.entries(state.devices)) if (v.sessionId === d.sessionId) delete state.devices[k]
			for (const [k, v] of access) if (v.sessionId === d.sessionId) access.delete(k)
			for (const [k, v] of Object.entries(state.browsers)) if (v.sessionId === d.sessionId) delete state.browsers[k]
			await save()
		},
		async refresh(deviceToken) {
			const d = typeof deviceToken === 'string' ? state.devices[deviceToken] : null
			if (!d || d.expiresAt < now()) throw new RpcError('UNAUTHORIZED', 'Invalid native session')
			d.expiresAt = now() + DEVICE_TTL
			await save()
			return issueAccess(d.userId, d.sessionId)
		},
		// Browser login: a bearer token tied to a cookie, for file links and (later) consoles.
		async loginBrowser(input) {
			return issueBrowser((await verify(input ?? {})).userId)
		},
		// A browser session for someone already signed in (the web app's console session): no second
		// password check, so a one-time 2FA code isn't needed twice.
		async browserFor(auth) {
			if (!auth?.userId) throw new RpcError('UNAUTHORIZED', 'Sign in first')
			return issueBrowser(auth.userId)
		},
		async renewBrowser(bearer) {
			const b = state.browsers[bearer]
			if (b) {
				b.expiresAt = now() + BROWSER_TTL
				await save()
			}
		},
		// Who is calling: an access token, or a browser bearer with its cookie.
		authenticate(req) {
			const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
			if (!bearer) return null
			const a = access.get(bearer)
			if (a && a.expiresAt > now()) return {userId: a.userId, sessionId: a.sessionId, kind: 'native', bearer}
			const b = state.browsers[bearer]
			const cookie = /(?:^|;\s*)OMARCHY_BROWSER_SESSION=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
			if (b && b.expiresAt > now() && cookie && cookie.length === b.cookie.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(b.cookie))) {
				return {userId: b.userId, sessionId: b.sessionId, kind: 'browser', bearer}
			}
			return null
		},
		issueUrlToken(auth) {
			if (auth.kind !== 'browser') throw new RpcError('FORBIDDEN', 'Browser session required')
			prune()
			const t = token('url_')
			urlTokens.set(t, {bearer: auth.bearer, expiresAt: now() + URL_TOKEN_TTL})
			return t
		},
		// File links carry a url token and must come with that browser session's cookie.
		checkUrlToken(t, req) {
			const u = urlTokens.get(t)
			if (!u || u.expiresAt < now()) return null
			const b = state.browsers[u.bearer]
			const cookie = /(?:^|;\s*)OMARCHY_BROWSER_SESSION=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
			if (!b || !cookie || cookie !== b.cookie) return null
			return {userId: b.userId}
		},
		async logout(auth) {
			for (const [k, v] of access) if (v.sessionId === auth.sessionId) access.delete(k)
			for (const [k, v] of Object.entries(state.devices)) if (v.sessionId === auth.sessionId) delete state.devices[k]
			for (const [k, v] of Object.entries(state.browsers)) if (v.sessionId === auth.sessionId) delete state.browsers[k]
			await save()
		},
	}
}
