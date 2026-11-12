// Small JSON-file persistence for config and device sessions. Files are written
// atomically with mode 0600 because sessions hold umbrelOS device credentials.

import {createHash, randomBytes} from 'node:crypto'
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

async function readJson(file, fallback) {
	try {
		return JSON.parse(await readFile(file, 'utf8'))
	} catch (error) {
		if (error.code === 'ENOENT') return fallback
		throw error
	}
}

async function writeJson(file, value) {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
	await writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600})
	await rename(tmp, file)
	await chmod(file, 0o600).catch(() => {})
}

export const hashId = (id) => createHash('sha256').update(id).digest('hex')
export const newSessionId = () => randomBytes(32).toString('base64url')

export async function createStore(dataDir) {
	await mkdir(dataDir, {recursive: true, mode: 0o700})
	const configFile = join(dataDir, 'config.json')
	const sessionsFile = join(dataDir, 'sessions.json')

	let config = await readJson(configFile, {})
	// Keyed by sha256(cookie value) so the file alone can't be replayed as a cookie.
	let sessions = await readJson(sessionsFile, {})
	let writing = Promise.resolve()
	const persistSessions = () => (writing = writing.then(() => writeJson(sessionsFile, sessions)).catch(() => {}))

	return {
		dataDir,
		getConfig: () => ({...config}),
		async setConfig(patch) {
			config = {...config, ...patch}
			await writeJson(configFile, config)
			return {...config}
		},
		getSession: (cookieId) => (cookieId ? sessions[hashId(cookieId)] : undefined),
		async putSession(cookieId, session) {
			sessions[hashId(cookieId)] = session
			await persistSessions()
		},
		async updateSession(cookieId, patch) {
			const key = hashId(cookieId)
			if (!sessions[key]) return
			sessions[key] = {...sessions[key], ...patch}
			await persistSessions()
		},
		async deleteSession(cookieId) {
			delete sessions[hashId(cookieId)]
			await persistSessions()
		},
		async clearSessions() {
			sessions = {}
			await persistSessions()
		},
		sessionCount: () => Object.keys(sessions).length,
	}
}
