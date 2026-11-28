// The gate in front of every request that arrives from outside through MODC Connect's tunnel.
//
// A request counts as remote when it arrives on the remote-ingress listener (127.0.0.1 only, for
// cloudflared) whatever its headers, or on the main listener from a proxy on this machine that says it
// is Cloudflare (CF-Connecting-IP, Cf-Access-Jwt-Assertion or CF-Ray). Each one must pass, in order:
//   1. Remote access is on, verified by the website, not blocked here, and the website's settings
//      were read recently (stale after 10 minutes without a successful read): otherwise 503.
//   2. It is for this server's own address (Host): otherwise 421.
//   3. It carries a valid Cloudflare Access token for the configured team and application: otherwise 403.
// Then the usual MODC sign-in applies as it always has: the Access token signs no one in.
//
// The settings come from omarchyd (GET /internal/remote-gate, on 127.0.0.1): only non-secret values,
// read every 10 seconds. When remote access goes off, everything remote is cut at once (see onClose).
import {createAccessVerifier, validAccessConfig} from './access-jwt.mjs'

export const STALE_MS = 10 * 60_000

export const GATE_MESSAGES = {
	REMOTE_OFF: 'Remote access to this server is turned off.',
	REMOTE_STALE: 'This server couldn’t confirm its remote-access settings with myowndatacenter.com recently, so remote access is paused.',
	REMOTE_BLOCKED: 'Remote access was switched off on this server.',
	WRONG_HOST: 'This address isn’t this server’s.',
	LEGACY_ORIGIN: 'Remote access uses this server’s remote listener only.',
	ACCESS_DENIED: 'Sign in through myowndatacenter.com first.',
}

export function createRemoteGate({fetchConfig, verifier = createAccessVerifier(), now = () => Date.now(), refreshMs = 10_000, log = (m) => console.error(m)}) {
	let config = null
	let loaded = null
	let timer = null
	const closers = new Set()

	// SSO only (contract v2): no Access token; the MODC session is the only way in (app.mjs).
	const ssoOnly = (c = config) => c?.mode === 'modc_sso'
	const modeOk = (c) => (ssoOnly(c) ? !!c.hostname : c?.mode !== 'modc_sso' && validAccessConfig(c))
	const open = (c = config) => !!c && c.enabled === true && c.verified === true && c.blocked !== true && Number.isFinite(c.syncedAt) && now() - c.syncedAt <= STALE_MS && modeOk(c)

	async function refresh() {
		const was = open()
		try {
			const c = await fetchConfig()
			config = c && typeof c === 'object' ? c : null
		} catch {
			// omarchyd isn't answering: keep the last settings; they go stale by themselves.
		}
		if (was && !open()) {
			log('[remote] remote access is off: closing remote connections')
			for (const fn of closers) {
				try {
					fn()
				} catch {}
			}
		}
		return config
	}

	function state() {
		if (!config || config.enabled !== true || config.verified !== true || !modeOk(config)) return 'REMOTE_OFF'
		if (config.blocked === true) return 'REMOTE_BLOCKED'
		if (!Number.isFinite(config.syncedAt) || now() - config.syncedAt > STALE_MS) return 'REMOTE_STALE'
		return 'OPEN'
	}

	// -> {ok: true, claims} | {ok: false, status, code, message}
	// as: 'modc_sso' evaluates the SSO-only (v2) rules against the live settings without switching modes;
	// used only by the self-test probe, which answers synthetically and never serves content.
	async function check(req, {as} = {}) {
		if (!loaded) loaded = refresh()
		await loaded
		const s = state()
		if (s !== 'OPEN') return {ok: false, status: 503, code: s, message: GATE_MESSAGES[s]}
		const host = String(req.headers.host ?? '')
			.toLowerCase()
			.replace(/:\d+$/, '')
		if (!config.hostname || host !== String(config.hostname).toLowerCase()) return {ok: false, status: 421, code: 'WRONG_HOST', message: GATE_MESSAGES.WRONG_HOST}
		if (ssoOnly() || as === 'modc_sso') {
			// Only the dedicated listener: the legacy origin (7780) carries nothing remote in this mode.
			if (req.socket?.__modcRemote !== true) return {ok: false, status: 421, code: 'LEGACY_ORIGIN', message: GATE_MESSAGES.LEGACY_ORIGIN}
			return {ok: true, mode: 'modc_sso', claims: null}
		}
		const r = await verifier.verify(req.headers['cf-access-jwt-assertion'], config)
		if (!r.ok) return {ok: false, status: 403, code: 'ACCESS_DENIED', reason: r.reason, message: GATE_MESSAGES.ACCESS_DENIED}
		return {ok: true, mode: 'cloudflare_access', claims: r.claims}
	}

	return {
		check,
		refresh,
		state,
		isOpen: () => open(),
		onClose(fn) {
			closers.add(fn)
			return () => closers.delete(fn)
		},
		start() {
			if (timer) return
			loaded = refresh()
			timer = setInterval(() => refresh().catch(() => {}), refreshMs)
			timer.unref?.()
		},
		stop() {
			if (timer) clearInterval(timer)
			timer = null
		},
	}
}
