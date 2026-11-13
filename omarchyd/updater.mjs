// Software update for omarchyd: check GitHub for a newer Omarchy Server, and update in place.
//
// Check: the version in package.json on the main branch, compared with the one installed. Release notes
// come from the What's New list (web/src/changelog.ts) for every version you don't have yet.
// Update: like the installer's update step, as you, without sudo: fetch, reset, npm ci, build, then
// restart both services from a detached systemd unit (so this process can be replaced). If a step
// fails, the previous version is restored and rebuilt. Parts that need root (system packages and the
// storage helper) aren't touched; when a new version changes them, the check says to run the installer.
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, rename, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {RpcError} from './rpc.mjs'

export const REPO_RAW = 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server'
export const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server/main/install.sh | bash'
const HELPER = '/usr/local/libexec/omarchy-server/helper.mjs'

function execP(cmd, args, {cwd, env, timeout = 15 * 60_000} = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, {cwd, env, timeout, maxBuffer: 32 * 1024 * 1024}, (error, stdout, stderr) => {
			if (error) {
				error.message = `${cmd} ${args[0] ?? ''}: ${(stderr || error.message).toString().trim().split('\n').slice(-3).join(' ')}`
				return reject(error)
			}
			resolve(stdout.toString())
		})
	})
}

export function compareVersions(a, b) {
	const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
	const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
	return 0
}

// Pull "what's new" for versions newer than `since` out of changelog.ts, as Markdown.
export function releaseNotes(changelogSource, since) {
	const strings = (block) => [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
	const out = []
	for (const part of String(changelogSource).split(/\bversion:\s*'/).slice(1)) {
		const version = part.slice(0, part.indexOf("'"))
		if (compareVersions(version, since) <= 0) continue
		const title = /\btitle:\s*'((?:[^'\\]|\\.)*)'/.exec(part)?.[1]
		const added = /\badded:\s*\[([\s\S]*?)\]/.exec(part)?.[1]
		const fixed = /\bfixed:\s*\[([\s\S]*?)\]/.exec(part)?.[1]
		out.push(
			[`**${version}${title ? ` · ${title}` : ''}**`, ...(added ? strings(added).map((s) => `- ${s}`) : []), ...(fixed ? strings(fixed).map((s) => `- Fixed: ${s}`) : [])].join('\n'),
		)
	}
	return out.join('\n\n')
}

export function createUpdater({autoCheck = true, appDir, dataDir, currentVersion, run = execP, fetchImpl = fetch, raw = REPO_RAW, branch = 'main', helperPath = HELPER, restartDelay = '2s'}) {
	const statusFile = join(dataDir, 'update.json')
	let status = {running: false, progress: 0, description: '', error: false}
	let cache = null
	let busy = false

	const save = async () => {
		await writeFile(`${statusFile}.tmp`, JSON.stringify(status), {mode: 0o600})
		await rename(`${statusFile}.tmp`, statusFile)
	}
	const ready = (async () => {
		try {
			const saved = JSON.parse(await readFile(statusFile, 'utf8'))
			// We were restarted by an update: report how it went.
			if (saved.running && saved.target) {
				status =
					compareVersions(currentVersion, saved.target) >= 0
						? {running: false, progress: 100, description: `Updated to ${saved.target}`, error: false}
						: {running: false, progress: 0, description: '', error: `The update to ${saved.target} didn’t take effect. Run the installer: ${INSTALL_COMMAND}`}
				await save()
			}
		} catch {}
	})()

	const get = async (path) => {
		const res = await fetchImpl(`${raw}/${branch}/${path}?t=${Date.now()}`, {signal: AbortSignal.timeout(15_000), headers: {'cache-control': 'no-cache'}})
		if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
		return res.text()
	}

	// Would the new version need the installer (root-level changes)?
	async function needsInstaller() {
		const reasons = []
		try {
			const remoteHelper = await get('helper/helper.mjs')
			const local = await readFile(helperPath, 'utf8').catch(() => null)
			const hash = (t) => createHash('sha256').update(t).digest('hex')
			if (local !== null && hash(local) !== hash(remoteHelper)) reasons.push('the storage helper changed')
		} catch {}
		try {
			const install = await get('install.sh')
			const pkgs = (/for pkg in ([^;]+);/.exec(install)?.[1] ?? '').trim().split(/\s+/).filter((p) => /^[a-z0-9][a-z0-9+._-]*$/.test(p))
			const missing = []
			for (const p of pkgs) if (!(await run('pacman', ['-Q', p], {timeout: 10_000}).then(() => true, () => false))) missing.push(p)
			if (missing.length) reasons.push(`it needs new packages (${missing.join(', ')})`)
		} catch {}
		return reasons
	}

	async function check({force = false} = {}) {
		await ready
		if (!force && cache && Date.now() - cache.at < 10_000) return cache.value
		let pkg
		try {
			pkg = JSON.parse(await get('package.json'))
		} catch (error) {
			throw new RpcError('BAD_GATEWAY', `Couldn’t check for updates: ${error.message}`)
		}
		const latest = String(pkg.version ?? '')
		const available = compareVersions(latest, currentVersion) > 0
		let notes = ''
		if (available) {
			notes = await get('web/src/changelog.ts').then((t) => releaseNotes(t, currentVersion), () => '')
			const reasons = await needsInstaller()
			if (reasons.length) notes = `**After updating, run the installer on the server** (${reasons.join('; ')}):\n\n    ${INSTALL_COMMAND}\n\n${notes}`
		}
		const value = {available, version: available ? latest : currentVersion, name: `Omarchy Server ${available ? latest : currentVersion}`, ...(notes ? {releaseNotes: notes} : {})}
		cache = {at: Date.now(), value}
		return value
	}

	const step = async (progress, description) => {
		status = {...status, running: true, progress, description, error: false}
		await save()
	}

	async function update() {
		await ready
		if (busy) throw new RpcError('CONFLICT', 'An update is already running')
		const {available, version} = await check({force: true})
		if (!available) throw new RpcError('BAD_REQUEST', 'Omarchy Server is already up to date')
		if (!(await run('git', ['-C', appDir, 'rev-parse', 'HEAD']).then(() => true, () => false))) throw new RpcError('PRECONDITION_FAILED', `This copy can’t update itself. Run the installer: ${INSTALL_COMMAND}`)
		busy = true
		status = {running: true, progress: 2, description: 'Starting', error: false, target: version}
		await save()
		;(async () => {
			const previous = (await run('git', ['-C', appDir, 'rev-parse', 'HEAD'])).trim()
			try {
				await step(10, 'Downloading')
				await run('git', ['-C', appDir, 'fetch', '--depth', '1', 'origin', branch])
				await run('git', ['-C', appDir, 'reset', '--hard', `origin/${branch}`])
				await step(35, 'Installing parts')
				// Packages only when they changed (npm ci needs a lot of memory).
				await run(process.execPath, ['scripts/deps.mjs'], {cwd: appDir})
				await step(70, 'Building')
				await run('npm', ['run', 'build'], {cwd: appDir, env: {...process.env, NODE_OPTIONS: '--max-old-space-size=1024'}})
				await step(95, 'Restarting')
				// A separate, short-lived unit restarts both services, so this process can be replaced.
				await run('systemd-run', ['--user', '--collect', `--on-active=${restartDelay}`, `--unit=omarchy-server-update-${Date.now()}`, 'systemctl', '--user', 'restart', 'omarchyd.service', 'omarchy-server-web.service'])
			} catch (error) {
				// Put the previous version back so the services keep working.
				await run('git', ['-C', appDir, 'reset', '--hard', previous]).catch(() => {})
				await run(process.execPath, ['scripts/deps.mjs'], {cwd: appDir}).catch(() => {})
				await run('npm', ['run', 'build'], {cwd: appDir, env: {...process.env, NODE_OPTIONS: '--max-old-space-size=1024'}}).catch(() => {})
				status = {running: false, progress: 0, description: '', error: `The update failed and nothing changed: ${error.message}`}
				await save().catch(() => {})
			} finally {
				busy = false
			}
		})()
		return true
	}

	// Check GitHub in the background (a minute after start, then every 6 hours), so the bell can
	// say an update is waiting without anyone opening Settings.
	let known = null // the newest version seen by a check, when it's newer than this one
	const background = async () => {
		try {
			const v = await check({force: true})
			known = v.available ? v.version : null
		} catch {}
	}
	const timers = autoCheck ? [setTimeout(background, 60_000), setInterval(background, 6 * 60 * 60_000)] : []
	for (const t of timers) t.unref?.()

	return {
		ready,
		// The version waiting to be installed, if a check found one.
		updateWaiting: () => (cache?.value?.available ? cache.value.version : known),
		stop: () => timers.forEach((t) => (clearTimeout(t), clearInterval(t))),
		procedures: {
			'system.checkUpdate': {kind: 'query', run: () => check()},
			'system.update': {kind: 'mutation', run: update},
			'system.updateStatus': {kind: 'query', run: async () => (await ready, {running: status.running, progress: status.progress, description: status.description, error: status.error})},
			'system.getReleaseChannel': {kind: 'query', run: () => 'stable'},
			'system.setReleaseChannel': {
				kind: 'mutation',
				run: (input) => {
					if (input?.channel !== 'stable') throw new RpcError('BAD_REQUEST', 'Omarchy Server has only stable updates for now')
					return true
				},
			},
		},
	}
}
