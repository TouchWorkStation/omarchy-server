// Software update for omarchyd: check a source tree for a newer My Own Data Center, and update in place.
// Source: a local clone (`sourceDir`) when the caller passes one, otherwise GitHub on `main`.
//
// Check: the version in package.json on the main branch, compared with the one installed. Release notes
// come from the What's New list (web/src/changelog.ts) for every version you don't have yet.
// Update: like the installer's update step, as you, without sudo: fetch, reset, npm ci, build, then
// restart both services from a detached systemd unit (so this process can be replaced). If a step
// fails, the previous version is restored and rebuilt. Parts that need root (system packages and the
// storage helper) aren't touched; when a new version changes them, the check says to run the installer.
import {movedGithubUrl} from './moved.mjs'
import {writeAtomic} from './atomic.mjs'
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'
import {join} from 'node:path'

import {RpcError} from './rpc.mjs'
import {stoppedMessage} from './exec-error.mjs'

export const REPO_RAW = 'https://raw.githubusercontent.com/MyOwnDataCenter/server'
export const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash'
const shQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`
export const installCommand = (sourceDir) => (sourceDir ? `OMARCHY_SERVER_REPO=${shQuote(sourceDir)} bash ${shQuote(join(sourceDir, 'install.sh'))}` : INSTALL_COMMAND)
// The sign-in prompt runs this in a terminal. With a local source it must run that clone's
// install.sh, and keep the isolation variables, or the installer would rewrite the service
// without them and the next start would update from GitHub.
export function installerPromptCommand({sourceDir, appStoreDir, port, curl}) {
	if (!sourceDir) return curl
	const env = [`OMARCHY_SERVER_SOURCE=${shQuote(sourceDir)}`]
	if (appStoreDir) env.push(`OMARCHY_SERVER_APP_STORE=${shQuote(appStoreDir)}`)
	env.push(`OMARCHY_SERVER_REPO=${shQuote(sourceDir)}`, 'OMARCHY_SERVER_FROM_APP=1', `OMARCHY_SERVER_PORT=${port}`)
	return `${env.join(' ')} bash ${shQuote(join(sourceDir, 'install.sh'))}`
}
// Where this copy came from: the GitHub repository it was installed from (its git origin), so a copy
// installed from omarchy-server-dev checks and updates from there, and one from omarchy-server from there.
// ssh://, git://, credentials, www., and any host case are the same repository. Anything that is not
// GitHub is not turned into this raw URL (the caller must not fall back to the official repository).
export function rawFromOrigin(url) {
	const text = String(url ?? '').trim()
	if (!text) return null
	let host = ''
	let path = ''
	const proto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)(\/.*)?$/.exec(text)
	if (proto) {
		let authority = proto[1]
		const at = authority.lastIndexOf('@')
		if (at !== -1) authority = authority.slice(at + 1)
		host = authority.replace(/:\d+$/, '')
		path = proto[2] ?? ''
	} else {
		const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(text)
		if (!scp) return null
		host = scp[1]
		path = scp[2]
	}
	if (!/^(?:www\.)?github\.com$/i.test(host)) return null
	path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
	const parts = path.split('/')
	if (parts.length !== 2) return null
	const [owner, repo] = parts
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null
	return `https://raw.githubusercontent.com/${owner}/${repo}`
}
const HELPER = '/usr/local/libexec/omarchy-server/helper.mjs'

function execP(cmd, args, {cwd, env, timeout = 15 * 60_000} = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, {cwd, env, timeout, maxBuffer: 32 * 1024 * 1024}, (error, stdout, stderr) => {
			if (error) {
				error.message = stoppedMessage(`${cmd} ${args[0] ?? ''}`.trim(), error, timeout) ?? `${cmd} ${args[0] ?? ''}: ${(stderr || error.message).toString().trim().split('\n').slice(-3).join(' ')}`
				return reject(error)
			}
			resolve(stdout.toString())
		})
	})
}

// Each part is a number with an optional letter after it: 0.9.93 < 0.9.93A < 0.9.93B < 0.9.94.
// (Comparing the numbers alone made 0.9.93B look the same as 0.9.93A, so it was never offered.)
const versionParts = (v) =>
	String(v)
		.split(/[.-]/)
		.map((x) => {
			const m = /^(\d*)([A-Za-z]*)/.exec(x) ?? []
			return [Number.parseInt(m[1], 10) || 0, (m[2] ?? '').toUpperCase()]
		})
export function compareVersions(a, b) {
	const pa = versionParts(a)
	const pb = versionParts(b)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const [na, la] = pa[i] ?? [0, '']
		const [nb, lb] = pb[i] ?? [0, '']
		if (na !== nb) return na > nb ? 1 : -1
		if (la !== lb) return la.length !== lb.length ? (la.length > lb.length ? 1 : -1) : la > lb ? 1 : -1
	}
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

// While My Own Data Center is in beta, an update that needs the installer asks the owner to run it at their
// next sign-in (people update in the app and never re-run the installer). Set to false after beta: the
// update check still says when the installer is needed, in its release notes.
export const BETA_INSTALLER_PROMPT = true

// install.sh's INSTALLER_REVISION: raised when a change needs the installer run again. The installer
// writes the one it ran to <data>/installer-revision when it finishes.
export function installerRevision(script) {
	const m = /^INSTALLER_REVISION=(\d+)\s*$/m.exec(String(script ?? ''))
	return m ? Number(m[1]) : 0
}
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/
export const installerPackages = (script) => (/for pkg in ([^;]+);/.exec(String(script ?? ''))?.[1] ?? '').trim().split(/\s+/).filter((p) => PACKAGE_NAME.test(p))

export function createUpdater({
	autoCheck = true,
	appDir,
	dataDir,
	currentVersion,
	run = execP,
	fetchImpl = fetch,
	raw = null,
	branch = 'main',
	helperPath = HELPER,
	restartDelay = '2s',
	webPort = 7780,
	// Callers pass sourceDir (startOmarchyd). Do not default it from OMARCHY_SERVER_SOURCE here:
	// tests mock GitHub and would otherwise read the live clone.
	sourceDir,
	appStoreDir,
	// Only a copy the installer set up (running as a systemd service) is checked; not a dev run.
	installerCheck = BETA_INSTALLER_PROMPT && !!process.env.INVOCATION_ID,
}) {
	// raw is a GitHub raw base when this origin is GitHub (or when git has no origin). origin is the
	// remote URL. A file://, GitLab, or other non-GitHub origin keeps raw null so nothing here reads
	// REPO_RAW instead of that remote.
	let resolved = null
	async function resolveSource() {
		if (resolved) return resolved
		if (raw) return (resolved = {raw, origin: null})
		let origin = ''
		try {
			origin = String(await run('git', ['-C', appDir, 'remote', 'get-url', 'origin'], {timeout: 10_000})).trim()
		} catch {
			origin = ''
		}
		if (!origin) return (resolved = {raw: REPO_RAW, origin: null})
		// Installed from the project's old GitHub address: move this copy's origin to the new one
		// (GitHub's redirect from the old name lasts only until someone else takes it).
		const moved = movedGithubUrl(origin)
		if (moved) {
			await run('git', ['-C', appDir, 'remote', 'set-url', 'origin', moved], {timeout: 10_000}).catch(() => {})
			origin = moved
		}
		const parsed = rawFromOrigin(origin)
		return (resolved = parsed ? {raw: parsed, origin} : {raw: null, origin})
	}
	// Pairing wants a URL for this copy. Non-GitHub installs report their real origin, not REPO_RAW.
	const source = async () => {
		const where = await resolveSource()
		return where.raw ?? where.origin ?? REPO_RAW
	}
	const installerHint = async () => {
		const port = Number(webPort) || 7780
		const where = await resolveSource()
		const curl = where.raw
			? `curl -fsSL ${where.raw}/${branch}/install.sh | bash`
			: `OMARCHY_SERVER_REPO=${shQuote(where.origin)} bash ${shQuote(join(appDir, 'install.sh'))}`
		return installerPromptCommand({sourceDir, appStoreDir, port, curl})
	}
	let originTree = null
	let originFetch = null
	// package.json and the other check files, from a remote that has no raw.githubusercontent URL.
	async function readGitFile(origin, path) {
		if (!origin) throw new Error("this install's source cannot be checked")
		if (!originTree) {
			originFetch ??= (async () => {
				const listed = await run('git', ['-C', appDir, 'ls-remote', origin, `refs/heads/${branch}`], {timeout: 20_000})
				if (!String(listed).trim()) throw new Error("this install's source cannot be checked")
				await run('git', ['-C', appDir, 'fetch', '--depth', '1', origin, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {timeout: 15 * 60_000})
				originTree = `origin/${branch}`
			})()
			try {
				await originFetch
			} catch (error) {
				originFetch = null
				throw error
			}
		}
		return await run('git', ['-C', appDir, 'show', `${originTree}:${path}`], {timeout: 10_000})
	}
	const statusFile = join(dataDir, 'update.json')
	let status = {running: false, progress: 0, description: '', error: false}
	let cache = null
	let busy = false

	const save = async () => {
		await writeAtomic(statusFile, JSON.stringify(status))
	}
	const ready = (async () => {
		try {
			const saved = JSON.parse(await readFile(statusFile, 'utf8'))
			// We were restarted by an update: report how it went.
			if (saved.running && saved.target) {
				status =
					compareVersions(currentVersion, saved.target) >= 0
						? {running: false, progress: 100, description: `Updated to ${saved.target}`, error: false}
						: {running: false, progress: 0, description: '', error: `The update to ${saved.target} didn’t take effect. Run the installer: ${await installerHint()}`}
				await save()
			}
		} catch {}
	})()

	const get = async (path) => {
		if (sourceDir) {
			try {
				return await readFile(join(sourceDir, path), 'utf8')
			} catch (error) {
				throw new Error(`${join(sourceDir, path)}: ${error.message}`)
			}
		}
		const where = await resolveSource()
		if (!where.raw) return readGitFile(where.origin, path)
		const res = await fetchImpl(`${where.raw}/${branch}/${path}?t=${Date.now()}`, {signal: AbortSignal.timeout(15_000), headers: {'cache-control': 'no-cache'}})
		if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
		return res.text()
	}
	const head = async (dir) => (await run('git', ['-C', dir, 'rev-parse', 'HEAD'], {timeout: 10_000})).trim()

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
			const pkgs = installerPackages(install)
			const missing = []
			for (const p of pkgs) if (!(await run('pacman', ['-Q', p], {timeout: 10_000}).then(() => true, () => false))) missing.push(p)
			if (missing.length) reasons.push(`it needs new packages (${missing.join(', ')})`)
		} catch {}
		return reasons
	}

	// Testing a development build: an "update-hold" file in the data folder stops updates from
	// replacing it. Remove the file to update normally again.
	const holdFile = dataDir ? join(dataDir, 'update-hold') : null
	const held = async () => !!holdFile && !!(await stat(holdFile).catch(() => null))
	const HELD = 'Updates are paused on this server while a development build is tested. To update again, remove ~/.local/share/omarchy-server/omarchyd/update-hold.'

	async function check({force = false} = {}) {
		await ready
		if (await held()) return {available: false, held: true, version: currentVersion, name: `MODC ${currentVersion}`, releaseNotes: HELD}
		if (!force && cache && Date.now() - cache.at < 10_000) return cache.value
		// A remote without a raw URL is read from a fetched copy. Fetch it again for each check,
		// or a version published after the first check is never seen.
		originTree = null
		originFetch = null
		let pkg
		try {
			pkg = JSON.parse(await get('package.json'))
		} catch (error) {
			throw new RpcError('BAD_GATEWAY', `Couldn’t check for updates: ${error.message}`)
		}
		const latest = String(pkg.version ?? '')
		let available = compareVersions(latest, currentVersion) > 0
		if (!available && sourceDir && compareVersions(latest, currentVersion) === 0) {
			const [src, app] = await Promise.all([head(sourceDir).catch(() => ''), head(appDir).catch(() => '')])
			if (src && app && src !== app) available = true
		}
		let notes = ''
		if (available) {
			notes = await get('web/src/changelog.ts').then((t) => releaseNotes(t, currentVersion), () => '')
			const reasons = await needsInstaller()
			if (reasons.length) notes = `**After updating, run the installer on the server** (${reasons.join('; ')}):\n\n    ${await installerHint()}\n\n${notes}`
		}
		const value = {available, version: available ? latest : currentVersion, name: `MODC ${available ? latest : currentVersion}`, ...(notes ? {releaseNotes: notes} : {})}
		cache = {at: Date.now(), value}
		return value
	}

	const step = async (progress, description) => {
		status = {...status, running: true, progress, description, error: false}
		await save()
	}

	async function update() {
		// Before anything else: the busy flag below must be claimed with no wait in between.
		if (await held()) throw new RpcError('PRECONDITION_FAILED', HELD)
		await ready
		if (busy) throw new RpcError('CONFLICT', 'An update is already running')
		// Claim it before the first await, so a second request in the meantime is refused too.
		busy = true
		let version
		try {
			const checked = await check({force: true})
			version = checked.version
			if (!checked.available) throw new RpcError('BAD_REQUEST', 'My Own Data Center is already up to date')
			if (!(await run('git', ['-C', appDir, 'rev-parse', 'HEAD']).then(() => true, () => false))) throw new RpcError('PRECONDITION_FAILED', `This copy can’t update itself. Run the installer: ${await installerHint()}`)
		} catch (error) {
			busy = false
			throw error
		}
		// If this write throws, the background work never starts, so its finally would never clear the flag.
		const previousStatus = status
		status = {running: true, progress: 2, description: 'Starting', error: false, target: version}
		try {
			await save()
		} catch (error) {
			busy = false
			status = previousStatus
			throw error
		}
		;(async () => {
			// A failure to read the current revision is a failed update, not a crash.
			let previous = ''
			// Set only once a reset is about to change the tree. A failed fetch has not, so it must not restore.
			let treeChanged = false
			try {
				previous = (await run('git', ['-C', appDir, 'rev-parse', 'HEAD'])).trim()
				await step(10, 'Downloading')
				if (sourceDir) {
					await run('git', ['-C', appDir, 'fetch', '--depth', '1', sourceDir, 'HEAD'])
					treeChanged = true
					await run('git', ['-C', appDir, 'reset', '--hard', 'FETCH_HEAD'])
				} else {
					// Name where it lands: a shallow clone of another branch doesn't track this one otherwise.
					await run('git', ['-C', appDir, 'fetch', '--depth', '1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
					treeChanged = true
					await run('git', ['-C', appDir, 'reset', '--hard', `origin/${branch}`])
				}
				await step(35, 'Installing parts')
				// Packages only when they changed (npm ci needs a lot of memory).
				await run(process.execPath, ['scripts/deps.mjs'], {cwd: appDir})
				await step(70, 'Building')
				await run('npm', ['run', 'build'], {cwd: appDir, env: {...process.env, NODE_OPTIONS: '--max-old-space-size=1024'}})
				await step(95, 'Restarting')
				// A separate, short-lived unit restarts both services, so this process can be replaced.
				await run('systemd-run', ['--user', '--collect', `--on-active=${restartDelay}`, `--unit=omarchy-server-update-${Date.now()}`, 'systemctl', '--user', 'restart', 'omarchyd.service', 'omarchy-server-web.service'])
			} catch (error) {
				// Put the previous version back so the services keep working. Nothing was changed
				// when the current revision could not be read, or when fetch failed before reset,
				// so there is nothing to put back. Leave "Downloading" before any of that work.
				// Say so if putting it back fails.
				let restored = true
				if (previous && treeChanged) {
					await step(10, 'Restoring').catch(() => {})
					const back = (p) => p.then(() => true, () => false)
					restored = (await back(run('git', ['-C', appDir, 'reset', '--hard', previous]))) && (await back(run(process.execPath, ['scripts/deps.mjs'], {cwd: appDir}))) && (await back(run('npm', ['run', 'build'], {cwd: appDir, env: {...process.env, NODE_OPTIONS: '--max-old-space-size=1024'}})))
				}
				status = {running: false, progress: 0, description: '', error: restored ? `The update failed and nothing changed: ${error.message}` : `The update failed, and putting the previous version back failed too. Run the installer: ${await installerHint().catch(() => 'see the README')}. (${error.message})`}
				await save().catch(() => {})
			} finally {
				busy = false
			}
		})()
		return true
	}

	// Does this copy, as it is now (after an update in the app), need the installer run again? Read only
	// from this machine: the installer this version ships, what the installer last ran, the installed
	// storage helper, and the system packages.
	const hash = (t) => createHash('sha256').update(t).digest('hex')
	let installerCache = null
	async function installerStatus() {
		if (!installerCheck) return {needed: false, reasons: []}
		if (installerCache && Date.now() - installerCache.at < 30_000) return installerCache.value
		const script = await readFile(join(appDir, 'install.sh'), 'utf8').catch(() => null)
		const reasons = []
		if (script !== null) {
			const ran = Number.parseInt(await readFile(join(dataDir, 'installer-revision'), 'utf8').catch(() => '0'), 10) || 0
			if (installerRevision(script) > ran) reasons.push('This update changed what the installer sets up.')
			const shipped = await readFile(join(appDir, 'helper', 'helper.mjs'), 'utf8').catch(() => null)
			const installed = await readFile(helperPath, 'utf8').catch(() => null)
			if (shipped !== null && installed === null) reasons.push('The storage helper isn’t installed.')
			else if (shipped !== null && hash(shipped) !== hash(installed)) reasons.push('The storage helper changed.')
			const missing = []
			for (const p of installerPackages(script)) if (!(await run('pacman', ['-Q', p], {timeout: 10_000}).then(() => true, () => false))) missing.push(p)
			if (missing.length) reasons.push(`New system packages are needed: ${missing.join(', ')}.`)
		}
		const port = Number(webPort) || 7780
		const where = await resolveSource()
		const curl = where.raw
			? `curl -fsSL ${where.raw}/${branch}/install.sh | OMARCHY_SERVER_FROM_APP=1 OMARCHY_SERVER_PORT=${port} bash`
			: `OMARCHY_SERVER_REPO=${shQuote(where.origin)} OMARCHY_SERVER_FROM_APP=1 OMARCHY_SERVER_PORT=${port} bash ${shQuote(join(appDir, 'install.sh'))}`
		const value = reasons.length
			? {needed: true, reasons, command: installerPromptCommand({sourceDir, appStoreDir, port, curl})}
			: {needed: false, reasons: []}
		installerCache = {at: Date.now(), value}
		return value
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
	// Check soon after starting, then every 30 minutes (a small file from GitHub), so the bell lights up
	// soon after an update is published.
	const timers = autoCheck ? [setTimeout(background, 60_000), setInterval(background, 30 * 60_000)] : []
	for (const t of timers) t.unref?.()

	return {
		ready,
		// The version waiting to be installed, if a check found one.
		updateWaiting: () => (cache?.value?.available ? cache.value.version : known),
		// Where this copy came from (raw.githubusercontent.com/<owner>/<repo>), e.g. for the connector's installer.
		source,
		stop: () => timers.forEach((t) => (clearTimeout(t), clearInterval(t))),
		procedures: {
			'system.checkUpdate': {kind: 'query', run: () => check()},
			'system.update': {kind: 'mutation', run: update},
			'system.updateStatus': {kind: 'query', run: async () => (await ready, {running: status.running, progress: status.progress, description: status.description, error: status.error})},
			'system.installerStatus': {kind: 'query', run: () => installerStatus()},
			'system.getReleaseChannel': {kind: 'query', run: () => 'stable'},
			'system.setReleaseChannel': {
				kind: 'mutation',
				run: (input) => {
					if (input?.channel !== 'stable') throw new RpcError('BAD_REQUEST', 'Only stable updates are available for now')
					return true
				},
			},
		},
	}
}
