// Accounts and sessions. Passwords are scrypt-hashed; tokens are random and held server-side only.
// The owner account is created on the server itself (`omarchyd create-owner`), never over the web.
import {randomBytes, scrypt as scryptCb, timingSafeEqual} from 'node:crypto'
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'

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
async function checkPassword(password, user) {
	const {hash} = await hashPassword(password, Buffer.from(user.salt, 'base64'))
	const a = Buffer.from(hash, 'base64')
	const b = Buffer.from(user.hash, 'base64')
	return a.length === b.length && timingSafeEqual(a, b)
}

export async function openAccounts(dataDir) {
	await mkdir(dataDir, {recursive: true, mode: 0o700})
	const file = join(dataDir, 'accounts.json')
	let state = {users: [], devices: {}, browsers: {}}
	try {
		state = {...state, ...JSON.parse(await readFile(file, 'utf8'))}
	} catch {}
	// Short-lived tokens stay in memory; device and browser sessions survive restarts.
	const access = new Map() // accessToken -> {userId, sessionId, expiresAt}
	const urlTokens = new Map() // url token -> {browserToken, expiresAt}
	let saving = Promise.resolve()
	const save = () =>
		(saving = saving.then(async () => {
			const tmp = `${file}.tmp`
			await writeFile(tmp, JSON.stringify(state, null, '\t'), {mode: 0o600})
			await rename(tmp, file)
			await chmod(file, 0o600).catch(() => {})
		}))
	const now = () => Date.now()
	const prune = () => {
		for (const [k, v] of access) if (v.expiresAt < now()) access.delete(k)
		for (const [k, v] of urlTokens) if (v.expiresAt < now()) urlTokens.delete(k)
		for (const [k, v] of Object.entries(state.devices)) if (v.expiresAt < now()) delete state.devices[k]
		for (const [k, v] of Object.entries(state.browsers)) if (v.expiresAt < now()) delete state.browsers[k]
	}
	const userById = (id) => state.users.find((u) => u.userId === id)
	const publicUser = (u) => ({userId: u.userId, name: u.name, role: u.role, language: u.language ?? 'en', wallpaper: u.wallpaper ?? {id: 'omarchy'}})

	async function verify({userId, password}) {
		const user = userId ? userById(userId) : state.users[0]
		if (!user || typeof password !== 'string' || !(await checkPassword(password, user))) {
			await new Promise((r) => setTimeout(r, 300 + Math.random() * 300))
			throw new RpcError('UNAUTHORIZED', 'Incorrect password')
		}
		return user
	}
	function issueAccess(userId, sessionId) {
		const accessToken = token('at_')
		const accessExpiresAt = now() + ACCESS_TTL
		access.set(accessToken, {userId, sessionId, expiresAt: accessExpiresAt})
		return {accessToken, accessExpiresAt}
	}

	return {
		hasOwner: () => state.users.length > 0,
		async createOwner({name, password}) {
			if (state.users.length) throw new Error('An owner account already exists')
			if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(name ?? '')) throw new Error('Use 1-40 letters, numbers, spaces, dots, dashes or underscores for the name')
			if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password of at least 8 characters')
			state.users.push({userId: 'owner', name: name.trim(), role: 'owner', language: 'en', ...(await hashPassword(password)), createdAt: now()})
			await save()
		},
		async setPassword(userId, {oldPassword, newPassword}) {
			const user = await verify({userId, password: oldPassword})
			if (typeof newPassword !== 'string' || newPassword.length < 8) throw new RpcError('BAD_REQUEST', 'Use a password of at least 8 characters')
			Object.assign(user, await hashPassword(newPassword))
			// A new password signs out every other session.
			state.devices = {}
			state.browsers = {}
			access.clear()
			await save()
		},
		listAccounts: () => state.users.map(publicUser),
		getUser: (userId) => {
			const u = userById(userId)
			return u ? publicUser(u) : null
		},
		async updateUser(userId, patch) {
			const u = userById(userId)
			if (!u) throw new RpcError('NOT_FOUND', 'No such account')
			if (typeof patch?.name === 'string' && patch.name.trim()) u.name = patch.name.trim().slice(0, 40)
			if (typeof patch?.language === 'string') u.language = patch.language.slice(0, 10)
			if (typeof patch?.wallpaper === 'string') u.wallpaper = {id: patch.wallpaper.slice(0, 40)}
			await save()
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
		async refresh(deviceToken) {
			const d = typeof deviceToken === 'string' ? state.devices[deviceToken] : null
			if (!d || d.expiresAt < now()) throw new RpcError('UNAUTHORIZED', 'Invalid native session')
			d.expiresAt = now() + DEVICE_TTL
			await save()
			return issueAccess(d.userId, d.sessionId)
		},
		// Browser login: a bearer token tied to a cookie, for file links and (later) consoles.
		async loginBrowser(input) {
			const user = await verify(input ?? {})
			prune()
			const bearer = token('bt_')
			const cookie = token()
			state.browsers[bearer] = {userId: user.userId, cookie, sessionId: token('s_'), createdAt: now(), expiresAt: now() + BROWSER_TTL}
			await save()
			return {bearer, cookie}
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
