// Settings › MODC Connect: link this server to the owner's myowndatacenter.com account.
// omarchyd does the talking (omarchyd/connect.mjs). This page only ever sees the code, the countdown,
// the website link and the status: never the polling secret or the device key, and it stores nothing.
import {useEffect, useMemo, useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import qrcode from 'qrcode-generator'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {Field, Group, Row, StatusPill, Switch, haptic, useConfirm, useToast, type StatusKind} from '../ui'

export type ConnectStatus = {
	state: 'none' | 'pairing' | 'connecting' | 'connected' | 'offline' | 'revoked'
	pairing?: {code: string; expiresAt: number; pairUrl: string; name: string}
	device: {deviceId: string; dataCenterId: string; name: string; pairedAt: number | null} | null
	lastCheckIn: number | null
	lastAttemptAt: number | null
	nextAttemptAt: number | null
	problem: null | 'offline' | 'rate_limited' | 'unavailable' | 'error'
	notice: null | {kind: string; message: string; at: number}
	revokedAt?: number
	siteUrl: string
	defaultName: string
	tunnel?: TunnelStatus | null
	remote?: RemoteStatus | null
}

// Remote access (omarchyd/connect-remote.mjs). Non-secret: settings, sync time, local block.
export type RemoteStatus = {
	state: string | null
	hostname: string | null
	configVersion: string | number | null
	accessProtected: boolean
	connectorValidated: boolean
	syncedAt: number | null
	stale: boolean
	blocked: null | {at: number; reason: string}
	warning: null | {kind: string; message: string; at: number}
	problem: null | string
	nextCheckAt: number | null
}

const REMOTE_PROBLEM: Record<string, string> = {
	contract_pending: 'This build doesn’t read the website’s remote-access settings yet, so remote access stays off here.',
	unreadable: 'The website’s remote-access settings couldn’t be read, so remote access stays off here.',
	other_device: 'The website sent settings for another device, so they were ignored.',
	offline: 'Can’t reach myowndatacenter.com. Remote access pauses if this lasts 30 minutes.',
	unavailable: 'myowndatacenter.com is having trouble. Remote access pauses if this lasts 30 minutes.',
	rate_limited: 'The website asked this server to slow down.',
	error: 'The website didn’t accept the request for remote-access settings.',
}

function RemoteSection({r, siteUrl, busy, run, now, confirm}: {r: RemoteStatus; siteUrl: string; busy: boolean; run: (path: string, done?: string) => void; now: number; confirm: ReturnType<typeof useConfirm>}) {
	const on = r.state === 'enabled' && !r.blocked && !r.stale && r.accessProtected && r.connectorValidated
	const pill: {kind: StatusKind; label: string} = r.blocked ? {kind: 'error', label: 'Blocked here'} : on ? {kind: 'running', label: 'On'} : r.state === 'enabled' ? {kind: 'update', label: 'Paused'} : {kind: 'stopped', label: 'Off'}
	const openSite = () => window.open(siteUrl, '_blank', 'noopener,noreferrer')
	const enable = async () => {
		if (r.blocked) {
			const ok = await confirm({
				title: 'Allow remote access on this server again?',
				body: 'Remote access was blocked here after an emergency switch-off. Allowing it again lifts that block; remote access still only works once you turn it on and approve it on myowndatacenter.com.',
				confirm: 'Allow',
			})
			if (!ok) return
			run('connect.remote.allow')
		}
		openSite()
	}
	const disable = async () => {
		const ok = await confirm({
			title: 'Switch remote access off?',
			body: 'Every remote browser is signed out and its connections are closed. Access here at home keeps working, and this server stays paired.',
			confirm: 'Switch off',
			danger: true,
		})
		if (ok) run('connect.remote.disable', 'Remote access switched off')
	}
	return (
		<>
			{r.warning && (
				<div className="glass connect-card critical" role="alert">
					<Icon name="alert" size={22} />
					<div>
						<b>Remote access is blocked on this server</b>
						<span>{r.warning.message}</span>
						<span className="connect-actions">
							<button className="btn small primary" disabled={busy} onClick={() => run('connect.remote.disable')}>
								Retry cloud switch-off
							</button>
						</span>
					</div>
				</div>
			)}
			<Group
				title="Remote access"
				footer="Turning remote access on is done on myowndatacenter.com, where you approve it. Every remote browser has to get past Cloudflare Access first, then sign in here as usual."
			>
				<Row icon="link" color="var(--accent)" label="Remote access" value={<StatusPill kind={pill.kind} label={pill.label} />} sub={r.hostname ? <span className="mono connect-host">{r.hostname}</span> : undefined} />
				<Row icon="shield" color="var(--green)" label="Access protection" value={r.accessProtected ? 'Cloudflare Access' : 'Not set up'} />
				<Row icon="check" color="var(--teal)" label="Connector checked" value={r.connectorValidated ? 'Yes' : 'Not yet'} />
				<Row
					icon="history"
					color="#8e8e93"
					label="Settings synced"
					value={r.syncedAt ? ago(r.syncedAt, now) : 'Never'}
					sub={r.problem ? REMOTE_PROBLEM[r.problem] : r.stale && r.syncedAt ? 'Out of date: remote access is paused until the next successful check.' : undefined}
				/>
				<Row icon="open" color="var(--blue)" label="Open My Data Centers" onClick={openSite} />
				{on ? (
					<Row icon="power" color="var(--red)" label="Switch remote access off" sub="Works even if the website can’t be reached" disabled={busy} onClick={disable} />
				) : (
					<Row icon="link" color="var(--accent)" label="Turn on remote access" sub="On myowndatacenter.com, where you approve it" disabled={busy} onClick={enable} />
				)}
				{!on && r.state === 'enabled' && <Row icon="power" color="var(--red)" label="Switch remote access off" disabled={busy} onClick={disable} />}
				<Row icon="restart" color="var(--accent)" label="Check now" disabled={busy} onClick={() => run('connect.remote.check')} />
			</Group>
		</>
	)
}

// The Cloudflare connector (omarchyd/connect-tunnel.mjs). No token or credential ever reaches here.
export type TunnelStatus = {
	enabled: boolean
	hostname: string | null
	provisioning: null | 'provisioning' | 'active' | 'failed' | 'deleting' | 'unknown'
	provisioningNote: string | null
	health: null | 'healthy' | 'degraded' | 'down' | 'inactive' | 'unknown' | 'connecting'
	connections: number
	colos: string[]
	connectedSince: number | null
	connectorError: string | null
	lastHealthyAt: number | null
	checkedAt: number | null
	remoteAccess: boolean
	ingress: string
	accessVerified?: boolean
	rotatedAt: number | null
	rotationRequired: boolean
	tokenIssuedAt: number | null
	block: null | {code: string; message: string; recovery: string; detail?: string | null; at: number}
	problem: null | string
	nextCheckAt: number | null
	cloudflared: {installed: boolean; version: string | null; compatible: boolean; source: null | 'system' | 'managed'; installable: boolean; pinnedVersion: string; minimum: string; installing: boolean}
	service: {state: string; since: number | null; restarts: number; failing: boolean; running?: boolean}
	others: string[]
}

const TUNNEL_PROBLEM: Record<string, string> = {
	offline: 'Can’t reach myowndatacenter.com to check the tunnel. A running connector keeps running.',
	unavailable: 'myowndatacenter.com is having trouble. A running connector keeps running; it checks again in 5 minutes.',
	rate_limited: 'The website asked this server to slow down. It checks again shortly.',
	token_retry: 'Getting the tunnel key didn’t work yet. It tries again by itself (up to 3 times).',
	token_wait: 'The tunnel key was asked for several times this hour. It waits before asking again.',
	service: 'The connector service didn’t start. Its log: journalctl --user -u modc-cloudflared',
	cloudflared: 'cloudflared is missing or too old on this computer. Install it below.',
	protection_unverified: 'Couldn’t confirm that Cloudflare Access guards your address (no internet?), so the connector is paused. It checks again in 5 minutes.',
}
const PROVISIONING_LABEL: Record<string, string> = {provisioning: 'Being set up', active: 'Ready', failed: 'Failed', deleting: 'Being removed', unknown: 'Unknown'}

function healthPill(t: TunnelStatus): {kind: StatusKind; label: string} {
	if (!t.enabled) return {kind: 'stopped', label: 'Off'}
	if (t.block) return {kind: 'stopped', label: 'Stopped'}
	switch (t.health) {
		case 'healthy':
			return {kind: 'running', label: 'Healthy'}
		case 'degraded':
			return {kind: 'update', label: 'Degraded'}
		case 'connecting':
			return {kind: 'busy', label: 'Connecting'}
		case 'down':
			return {kind: 'error', label: 'Down'}
		case 'inactive':
			return {kind: 'error', label: 'Not connected'}
		default:
			return {kind: 'stopped', label: 'Unknown'}
	}
}

function TunnelSection({t, busy, run, now}: {t: TunnelStatus; busy: boolean; run: (path: string, done?: string) => void; now: number}) {
	const cf = t.cloudflared
	const pill = healthPill(t)
	const retryable = t.block && ['token_failed', 'bad_request', 'unsafe'].includes(t.block.code)
	const otherNames = t.others.map((o) => o.split(':')[1])
	return (
		<>
			{t.block && (
				<div className="glass connect-card warn" role="status">
					<Icon name="alert" size={22} />
					<div>
						<b>{t.block.message}</b>
						{t.block.detail && <span className="mono">{t.block.detail}</span>}
						<span>{t.block.recovery}</span>
						<span className="connect-actions">
							<button className="btn small primary" disabled={busy} onClick={() => run('connect.tunnel.check', 'Checked')}>
								{retryable ? 'Try again' : 'Check now'}
							</button>
						</span>
					</div>
				</div>
			)}
			<Group
				title="Secure tunnel"
				footer={
					<>
						{t.remoteAccess
							? 'Remote access is on: Cloudflare Access stands in front of your address, then your MODC sign-in. This server checks that Access is there before it runs the connector.'
							: 'Remote access is off: the tunnel is deny-all, so every request to your address gets a 404, and nothing on this server is reachable from the internet.'}
						{otherNames.length > 0 && ` Your own cloudflared (${otherNames.join(', ')}) is separate and left alone.`}
					</>
				}
			>
				<Row icon="link" color="var(--accent)" label="Your address" sub={t.hostname ? <span className="mono connect-host">{t.hostname}</span> : 'Not reserved yet'} />
				<Row icon="server" color="var(--teal)" label="Tunnel setup" value={t.provisioning ? PROVISIONING_LABEL[t.provisioning] : t.block?.code === 'no_tunnel' ? 'None yet' : '–'} sub={t.provisioningNote ?? undefined} />
				<Row
					icon="bolt"
					color="var(--green)"
					label="Connector"
					sub={!t.enabled ? 'Off: nothing runs' : t.service.running ? 'Running · starts with this server and reconnects by itself' : t.block ? 'On, but stopped (see above)' : 'On · starting…'}
					trailing={
						<Switch
							on={t.enabled}
							label="Connector"
							onChange={(on) => {
								if (busy || (on && !cf.compatible)) return
								haptic(6)
								run(on ? 'connect.tunnel.enable' : 'connect.tunnel.disable', on ? 'Connector on' : 'Connector off')
							}}
						/>
					}
				/>
				<Row
					icon="activity"
					color="var(--blue)"
					label="Connector health"
					value={<StatusPill kind={pill.kind} label={pill.label} />}
					sub={t.enabled && t.connections > 0 ? `${t.connections} connection${t.connections === 1 ? '' : 's'}${t.colos.length ? ` · ${t.colos.join(', ').toUpperCase()}` : ''}` : (t.connectorError ?? undefined)}
				/>
				<Row icon="clock" color="#8e8e93" label="Last connected" value={<span title={t.lastHealthyAt ? new Date(t.lastHealthyAt).toLocaleString() : undefined}>{ago(t.lastHealthyAt, now)}</span>} />
				<Row
					icon="download"
					color="var(--peach)"
					label="cloudflared"
					value={cf.installed ? `${cf.version ?? '?'}${cf.source === 'managed' ? ' · installed here' : ''}` : 'Not installed'}
					sub={!cf.compatible ? (cf.installed ? `Needs ${cf.minimum} or later` : 'Needed for the connector') : undefined}
				/>
				{!cf.compatible && cf.installable && (
					<Row
						icon="download"
						color="var(--accent)"
						label={cf.installing ? 'Installing cloudflared…' : 'Install cloudflared'}
						sub={`Cloudflare’s ${cf.pinnedVersion} build, checked against its fingerprint. No password needed.`}
						disabled={busy || cf.installing}
						onClick={() => run('connect.tunnel.install', 'cloudflared installed')}
					/>
				)}
				<Row
					icon="shield"
					color="var(--green)"
					label="Remote access"
					value={!t.remoteAccess ? 'Off · deny-all' : t.accessVerified ? 'On · Access checked' : 'On · not checked'}
					sub={t.remoteAccess ? 'Cloudflare Access is in front; then your MODC sign-in' : undefined}
				/>
				<Row icon="restart" color="var(--accent)" label="Check now" disabled={busy} onClick={() => run('connect.tunnel.check', 'Checked')} />
			</Group>
			{(t.problem || t.service.failing || t.rotationRequired) && (
				<p className="muted connect-note" role="status">
					{t.service.failing ? 'The connector keeps stopping. Its log: journalctl --user -u modc-cloudflared. ' : ''}
					{t.rotationRequired ? 'The website is still replacing this tunnel’s credentials; the connector picks up the new key when it’s done. ' : ''}
					{t.problem ? TUNNEL_PROBLEM[t.problem] ?? '' : ''}
				</p>
			)}
		</>
	)
}

const PROBLEM: Record<string, string> = {
	offline: 'Can’t reach myowndatacenter.com right now. It keeps trying; everything on this server works as usual.',
	rate_limited: 'The website asked this server to slow down. It will try again shortly.',
	unavailable: 'myowndatacenter.com is having trouble. It keeps trying.',
	error: 'The website didn’t accept the last check-in. It will try again.',
}

// How the Settings row describes the connection.
export function connectSummary(s: ConnectStatus | undefined): string {
	if (!s) return ''
	return {none: 'Not connected', pairing: 'Waiting for approval', connecting: 'Checking in…', connected: 'Connected', offline: 'Offline', revoked: 'Removed'}[s.state]
}

export function ago(t: number | null, now = Date.now()): string {
	if (!t) return 'Never'
	const s = Math.max(0, Math.round((now - t) / 1000))
	if (s < 10) return 'Just now'
	if (s < 60) return `${s} seconds ago`
	const m = Math.round(s / 60)
	if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`
	const h = Math.round(m / 60)
	if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
	const d = Math.round(h / 24)
	return d === 1 ? 'Yesterday' : `${d} days ago`
}

export function countdown(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// A QR code as SVG squares. Dark on white whatever the theme, so every phone camera reads it.
export function qrPath(text: string): {size: number; d: string} {
	const qr = qrcode(0, 'M')
	qr.addData(text)
	qr.make()
	const n = qr.getModuleCount()
	let d = ''
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
	return {size: n + 8, d}
}

function Qr({text}: {text: string}) {
	const {size, d} = useMemo(() => qrPath(text), [text])
	return (
		<svg className="connect-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`QR code for ${text}`} shapeRendering="crispEdges">
			<rect width={size} height={size} fill="#fff" />
			<path d={d} fill="#000" />
		</svg>
	)
}

function useNow(every: number, on = true) {
	const [now, setNow] = useState(Date.now())
	useEffect(() => {
		if (!on) return
		const t = setInterval(() => setNow(Date.now()), every)
		return () => clearInterval(t)
	}, [every, on])
	return now
}

export function useConnectStatus(enabled = true) {
	return useQuery({
		queryKey: ['connect.status'],
		queryFn: () => query<ConnectStatus>('connect.status'),
		enabled,
		retry: false,
		// While a code waits, follow it closely; otherwise the minute-by-minute check-ins.
		refetchInterval: (q) => (q.state.data?.state === 'pairing' ? 2000 : 15_000),
	})
}

export function ConnectPage({onBack}: {onBack: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const status = useConnectStatus()
	const s = status.data
	const [name, setName] = useState<string | null>(null)
	const act = useMutation({
		mutationFn: (a: {path: string; input?: unknown; done?: string}) => mutate<ConnectStatus>(a.path, a.input),
		onSuccess: (data, a) => {
			if (data) qc.setQueryData(['connect.status'], data)
			if (a.done) toast(a.done)
		},
		onError: (e: Error) => toast(e.message, true),
	})
	const now = useNow(1000, s?.state === 'pairing' || !!s?.lastCheckIn)
	const left = s?.pairing ? s.pairing.expiresAt - now : 0
	useEffect(() => {
		// The countdown ran out here: ask omarchyd, which ends the pairing.
		if (s?.state === 'pairing' && left <= 0) qc.invalidateQueries({queryKey: ['connect.status']})
	}, [s?.state, left <= 0, qc])

	const startPairing = () => {
		haptic(6)
		act.mutate({path: 'connect.pair', input: {name: (name ?? s?.defaultName ?? '').trim()}})
	}
	const copyCode = async (code: string) => {
		try {
			await navigator.clipboard.writeText(code)
			haptic(8)
			toast('Code copied')
		} catch {
			toast('Couldn’t copy. Select the code and copy it yourself.', true)
		}
	}
	const disconnect = async () => {
		const ok = await confirm({
			title: 'Disconnect from myowndatacenter.com?',
			body: 'This server forgets its device key and stops checking in. To remove it from your account too, revoke it in My Data Centers on myowndatacenter.com. Nothing else on this server changes.',
			confirm: 'Disconnect',
			danger: true,
		})
		if (ok) act.mutate({path: 'connect.disconnect', done: 'Disconnected'})
	}

	const pill: {kind: StatusKind; label: string} | null = !s
		? null
		: s.state === 'connected'
			? {kind: 'running', label: 'Connected'}
			: s.state === 'offline'
				? {kind: 'error', label: 'Offline'}
				: s.state === 'connecting'
					? {kind: 'busy', label: 'Checking in'}
					: s.state === 'pairing'
						? {kind: 'busy', label: 'Waiting for approval'}
						: s.state === 'revoked'
							? {kind: 'stopped', label: 'Removed'}
							: {kind: 'stopped', label: 'Not connected'}

	return (
		<div className="stagger connect-page">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title">MODC Connect</h1>
			</div>
			<p className="muted connect-intro">
				Link this server to your myowndatacenter.com account so it shows up in My Data Centers. It checks in about once a minute. It doesn’t open this server to the internet, and sign-in here and
				everything else keep working without it, offline too.
			</p>

			{status.isError && (
				<div className="glass connect-card" role="alert">
					<Icon name="alert" size={22} />
					<span>{(status.error as Error).message}</span>
				</div>
			)}
			{!s && status.isLoading && (
				<div className="glass connect-card">
					<span className="spinner" /> Loading…
				</div>
			)}

			{s?.notice && s.state === 'none' && (
				<div className="glass connect-card warn" role="status">
					<Icon name="alert" size={22} />
					<div>
						<b>Not connected</b>
						<span>{s.notice.message}</span>
						<span className="connect-actions">
							<button className="btn small primary" disabled={act.isPending} onClick={startPairing}>
								Get a new code
							</button>
							<button className="btn small" disabled={act.isPending} onClick={() => act.mutate({path: 'connect.dismiss'})}>
								Dismiss
							</button>
						</span>
					</div>
				</div>
			)}

			{s?.state === 'none' && (
				<Group title="Connect this server" footer="You’ll get a code to approve on myowndatacenter.com. Codes last 10 minutes.">
					<div className="connect-form">
						<Field
							label="Name on myowndatacenter.com"
							value={name ?? s.defaultName}
							maxLength={60}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && startPairing()}
							autoComplete="off"
						/>
						<button className="btn primary block" disabled={act.isPending || !(name ?? s.defaultName).trim()} onClick={startPairing}>
							{act.isPending ? <span className="spinner" /> : <Icon name="link" size={18} />} Connect to myowndatacenter.com
						</button>
					</div>
				</Group>
			)}

			{s?.state === 'pairing' && s.pairing && (
				<section className="glass connect-pair">
					<div className="connect-pair-code">
						<span className="muted">Your code</span>
						<button className="connect-code mono" onClick={() => copyCode(s.pairing!.code)} aria-label={`Pairing code ${s.pairing.code.split('').join(' ')}. Copy`}>
							{s.pairing.code}
						</button>
						<span className={`connect-timer${left < 60_000 ? ' low' : ''}`} aria-live="polite">
							{left > 0 ? `Expires in ${countdown(left)}` : 'Expired'}
						</span>
					</div>
					<div className="connect-pair-qr">
						<Qr text={s.pairing.pairUrl} />
						<span className="muted">Scan to open myowndatacenter.com</span>
					</div>
					<ol className="connect-steps">
						<li>
							Open{' '}
							<a href={s.pairing.pairUrl} target="_blank" rel="noopener noreferrer">
								myowndatacenter.com/data-centers
							</a>{' '}
							and sign in.
						</li>
						<li>
							On your reserved data center, choose <b>Pair Device</b>.
						</li>
						<li>
							Enter <b className="mono">{s.pairing.code}</b> and approve <b>{s.pairing.name}</b>.
						</li>
					</ol>
					<p className="connect-wait" aria-live="polite">
						{s.problem ? (
							<>
								<Icon name="alert" size={16} /> {PROBLEM[s.problem]}
							</>
						) : (
							<>
								<span className="spinner" /> Waiting for you to approve it on the website…
							</>
						)}
					</p>
					<div className="connect-actions">
						<a className="btn primary" href={s.pairing.pairUrl} target="_blank" rel="noopener noreferrer">
							<Icon name="open" size={17} /> Open myowndatacenter.com
						</a>
						<button className="btn" disabled={act.isPending} onClick={() => act.mutate({path: 'connect.cancel'})}>
							Cancel
						</button>
					</div>
				</section>
			)}

			{s && (s.state === 'connected' || s.state === 'connecting' || s.state === 'offline' || s.state === 'revoked') && (
				<>
					{s.state === 'revoked' && (
						<div className="glass connect-card warn" role="status">
							<Icon name="alert" size={22} />
							<div>
								<b>Removed from your account</b>
								<span>This server was revoked on myowndatacenter.com, so it stopped checking in, stopped its tunnel connector and forgot its keys. Pair it again to reconnect.</span>
								<span className="connect-actions">
									<button className="btn small primary" disabled={act.isPending} onClick={startPairing}>
										Pair again
									</button>
									<button className="btn small" disabled={act.isPending} onClick={() => act.mutate({path: 'connect.dismiss'})}>
										Dismiss
									</button>
								</span>
							</div>
						</div>
					)}
					<Group title="Connection" footer={s.problem && s.state !== 'revoked' ? PROBLEM[s.problem] : undefined}>
						<Row icon="activity" color="var(--green)" label="Status" value={pill ? <StatusPill kind={pill.kind} label={pill.label} /> : ''} />
						<Row icon="clock" color="var(--blue)" label="Last check-in" value={<span title={s.lastCheckIn ? new Date(s.lastCheckIn).toLocaleString() : undefined}>{ago(s.lastCheckIn, now)}</span>} />
						{s.state !== 'revoked' && s.nextAttemptAt && <Row icon="history" color="#8e8e93" label="Next check-in" value={s.nextAttemptAt <= now ? 'Now' : `In ${countdown(s.nextAttemptAt - now)}`} />}
						{s.state !== 'revoked' && (
							<Row icon="restart" color="var(--accent)" label="Check in now" disabled={act.isPending} onClick={() => act.mutate({path: 'connect.checkNow'})} />
						)}
					</Group>
					{s.tunnel && s.state !== 'revoked' && <TunnelSection t={s.tunnel} busy={act.isPending} run={(path, done) => act.mutate({path, done})} now={now} />}
					{s.remote && s.state !== 'revoked' && <RemoteSection r={s.remote} siteUrl={s.siteUrl} busy={act.isPending} run={(path, done) => act.mutate({path, done})} now={now} confirm={confirm} />}
					{s.device && (
						<Group title="This device" footer="How this server appears in My Data Centers on myowndatacenter.com.">
							<Row icon="server" color="var(--teal)" label="Name" value={s.device.name || '–'} />
							<Row icon="key" color="#8e8e93" label="Device ID" value={<span className="mono connect-id">{s.device.deviceId}</span>} />
							<Row icon="grid" color="#8e8e93" label="Data center" value={<span className="mono connect-id">{s.device.dataCenterId}</span>} />
							{s.device.pairedAt && <Row icon="calendar" color="var(--blue)" label="Paired" value={new Date(s.device.pairedAt).toLocaleDateString()} />}
							<Row icon="open" color="var(--blue)" label="Manage on myowndatacenter.com" href={s.siteUrl} />
						</Group>
					)}
					{s.state !== 'revoked' && (
						<button className="btn block connect-disconnect" disabled={act.isPending} onClick={disconnect}>
							<Icon name="signout" size={17} /> Disconnect this server
						</button>
					)}
				</>
			)}
		</div>
	)
}
