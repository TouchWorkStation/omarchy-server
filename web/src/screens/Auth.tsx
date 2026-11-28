import {useState, type FormEvent} from 'react'

import {ApiError, login, setup, type Bootstrap} from '../api'
import {connectSubmitMode} from '../connection'
import {entrypointHost} from '../entrypointHost'
import {CREATE_OWNER_COMMAND, needsFirstAccount} from './firstAccount'
import {Icon} from '../icons'
import {Field, VersionTag, haptic} from '../ui'

function Logo() {
	return <img className="logo logo-modc" src="/modc-logo.png" alt="MODC" width={96} height={96} draggable={false} />
}

function ErrorBox({message, k}: {message: string; k: number}) {
	return (
		<div className="error shake" role="alert" key={k}>
			<Icon name="alert" size={18} />
			{message}
		</div>
	)
}

export function Connect({onDone, onRetry, unreachable}: {onDone: () => void; onRetry?: () => Promise<Bootstrap | null>; unreachable?: Bootstrap['server']}) {
	const [url, setUrl] = useState(unreachable?.url ?? '')
	const [edited, setEdited] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const [tries, setTries] = useState(0)
	const value = edited ? url : (unreachable?.url ?? '')
	const mode = connectSubmitMode(unreachable, value)
	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError('')
		try {
			if (mode === 'retry') {
				if (onRetry) {
					const next = await onRetry()
					if (next?.server?.reachable) {
						haptic(12)
					} else {
						setError(next?.server?.error ?? 'This server still isn’t answering. Wait a moment and try again.')
						setTries((t) => t + 1)
					}
				} else {
					onDone()
				}
				return
			}
			await setup(value.trim())
			haptic(12)
			onDone()
		} catch (err) {
			setError((err as Error).message)
			setTries((t) => t + 1)
		} finally {
			setBusy(false)
		}
	}
	return (
		<main className="auth center screen">
			<Logo />
			<h1>{unreachable ? 'Can’t reach your server' : 'Connect your server'}</h1>
			<p className="lead">
				{unreachable
					? unreachable.url
						? `Couldn’t reach ${unreachable.url}. Checking automatically — wait a moment or enter a different address.`
						: 'This server isn’t answering yet — it may be starting or restarting. Checking automatically…'
					: 'Enter the address you use to open My Own Data Center. Nothing on your server is changed.'}
			</p>
			<form onSubmit={submit}>
				{error && <ErrorBox message={error} k={tries} />}
				<Field
					id="url"
					label="Server address"
					inputMode="url"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					placeholder="192.168.1.50 or omarchy.local"
					value={value}
					onChange={(e) => {
						setEdited(true)
						setUrl(e.target.value)
					}}
					hint="An IP address is the most reliable. omarchy.local works on most home networks."
					required={!unreachable}
				/>
				<button className="btn primary block" disabled={busy || (mode === 'setup' && !value.trim())}>
					{busy ? <span className="spinner" /> : <Icon name="link" size={20} />}
					{busy ? 'Checking…' : mode === 'retry' ? 'Try again' : 'Connect'}
				</button>
			</form>
		</main>
	)
}

// A server with no account (after a factory reset, say): the form below could only say "Incorrect password".
function NoAccount({boot}: {boot: Bootstrap}) {
	return (
		<main className="auth center screen">
			<Logo />
			<h1>No account yet</h1>
			<p className="lead">{boot.server?.device ?? 'This server'} has no account to sign in with. The first account is made in a Terminal on the server itself. Run this there:</p>
			<pre className="mono" style={{whiteSpace: 'pre-wrap', wordBreak: 'break-all', textAlign: 'left', fontSize: 12.5, margin: '0 0 8px', userSelect: 'all'}}>{CREATE_OWNER_COMMAND}</pre>
			<p className="muted" style={{fontSize: 13, margin: '0 0 12px'}}>It asks for a name and a password. Reload this page afterwards to sign in.</p>
		</main>
	)
}

export function Login({boot, onDone}: {boot: Bootstrap; userId?: string; setUserId?: (id: string) => void; onDone: () => void}) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const [totp, setTotp] = useState('')
	const [needTotp, setNeedTotp] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const [tries, setTries] = useState(0)

	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError('')
		try {
			await login({username: username.trim(), password, ...(needTotp && totp ? {totpToken: totp.replace(/\s/g, '')} : {})})
			haptic(12)
			onDone()
		} catch (err) {
			const message = (err as ApiError).message
			if (/2FA/i.test(message) && !needTotp) setNeedTotp(true)
			else {
				setError(message)
				setTries((t) => t + 1)
				haptic([20, 40, 20])
			}
		} finally {
			setBusy(false)
		}
	}

	if (needsFirstAccount(boot)) return <NoAccount boot={boot} />

	return (
		<main className="auth center screen">
			<Logo />
			<h1>Sign in</h1>
			{boot.ssoOnly ? (
				<>
					<p className="lead">Use your myowndatacenter.com account.</p>
					<a className="btn primary block" href="/modc/auth/start">
						Continue with myowndatacenter.com
					</a>
				</>
			) : (
			<>
			<p className="lead">Use your username and password.</p>
			<form onSubmit={submit}>
				{error && <ErrorBox message={error} k={tries} />}
				<Field
					id="username"
					label="Username"
					labelHidden
					type="text"
					placeholder="Username"
					autoComplete="username"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					autoFocus
					required
				/>
				<Field
					id="password"
					label="Password"
					labelHidden
					type="password"
					placeholder="Password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
				{needTotp && (
					<Field
						id="totp"
						label="Two-factor code"
						wrapperClassName="screen"
						inputMode="numeric"
						autoComplete="one-time-code"
						pattern="[0-9 ]*"
						maxLength={7}
						placeholder="6-digit code"
						value={totp}
						onChange={(e) => setTotp(e.target.value)}
						hint="From your authenticator app."
						autoFocus
						required
						style={{textAlign: 'center', letterSpacing: '0.3em', fontSize: 20}}
					/>
				)}
				<button className="btn primary block" disabled={busy || !username.trim() || !password}>
					{busy ? <span className="spinner" /> : <Icon name="key" size={20} />}
					{busy ? 'Signing in…' : 'Sign in'}
				</button>
				{boot.sso && (
					<a className="btn block" href="/modc/auth/start" style={{marginTop: 10}}>
						Continue with myowndatacenter.com
					</a>
				)}
			</form>
			</>
			)}
			<div className="glass device-card" style={{marginTop: 28, marginBottom: 0}}>
				<span className="dot live" />
				<div style={{flex: 1, minWidth: 0}}>
					<div style={{fontWeight: 600, fontSize: 14}}>{boot.server?.device ?? 'server'}</div>
					<div className="muted" style={{fontSize: 12.5, marginTop: 2}}>
						{entrypointHost(boot.server)} ·{' '}
						<VersionTag
							version={boot.server?.name ?? (boot.server?.version ? `MODC ${boot.server.version}` : undefined)}
							info={boot.server}
						/>
					</div>
				</div>
				<Icon name="shield" size={20} className="muted" />
			</div>
			<p className="footer-note" style={{marginTop: 14}}>
				Shows up as its own device, so you can sign it out from Settings.
			</p>
		</main>
	)
}
