import {useState, type FormEvent} from 'react'

import {ApiError, login, setup, type Bootstrap} from '../api'
import {Icon} from '../icons'
import {haptic} from '../ui'

function Logo() {
	return (
		<div className="logo" aria-hidden="true">
			<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
				<path d="M3 12.5a9 9 0 0 1 18 0z" />
				<path d="M12 12.5v6a2.5 2.5 0 0 1-5 0" />
			</svg>
		</div>
	)
}

function ErrorBox({message, k}: {message: string; k: number}) {
	return (
		<div className="error shake" role="alert" key={k}>
			<Icon name="alert" size={18} />
			{message}
		</div>
	)
}

export function Connect({onDone, unreachable}: {onDone: () => void; unreachable?: Bootstrap['umbrel']}) {
	const [url, setUrl] = useState(unreachable?.url ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const [tries, setTries] = useState(0)
	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError('')
		try {
			await setup(url)
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
			<h1>{unreachable ? 'Can’t reach your Umbrel' : 'Connect your Umbrel'}</h1>
			<p className="lead">
				{unreachable
					? `UmbrelOS Touch couldn’t reach ${unreachable.url}. Check that it’s on and on this network, or enter its new address.`
					: 'Enter the address you use to open umbrelOS. Nothing on your Umbrel is changed.'}
			</p>
			<form onSubmit={submit}>
				{error && <ErrorBox message={error} k={tries} />}
				<div className="field">
					<label htmlFor="url">Umbrel address</label>
					<input
						id="url"
						inputMode="url"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						placeholder="192.168.1.50 or umbrel.local"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						required
					/>
					<span className="hint">An IP address is the most reliable. umbrel.local works on most home networks.</span>
				</div>
				<button className="btn primary block" disabled={busy || !url.trim()}>
					{busy ? <span className="spinner" /> : <Icon name="link" size={20} />}
					{busy ? 'Checking…' : unreachable ? 'Try again' : 'Connect'}
				</button>
			</form>
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

	return (
		<main className="auth center screen">
			<Logo />
			<h1>Sign in</h1>
			<p className="lead">Use your umbrelOS username and password.</p>
			<form onSubmit={submit}>
				{error && <ErrorBox message={error} k={tries} />}
				<div className="field">
					<label htmlFor="username" className="sr-only">
						Username
					</label>
					<input
						id="username"
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
				</div>
				<div className="field">
					<label htmlFor="password" className="sr-only">
						Password
					</label>
					<input
						id="password"
						type="password"
						placeholder="Password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
				</div>
				{needTotp && (
					<div className="field screen">
						<label htmlFor="totp">Two-factor code</label>
						<input
							id="totp"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9 ]*"
							maxLength={7}
							placeholder="6-digit code"
							value={totp}
							onChange={(e) => setTotp(e.target.value)}
							autoFocus
							required
							style={{textAlign: 'center', letterSpacing: '0.3em', fontSize: 20}}
						/>
						<span className="hint">From your authenticator app.</span>
					</div>
				)}
				<button className="btn primary block" disabled={busy || !username.trim() || !password}>
					{busy ? <span className="spinner" /> : <Icon name="key" size={20} />}
					{busy ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
			<div className="glass device-card" style={{marginTop: 28, marginBottom: 0}}>
				<span className="dot live" />
				<div style={{flex: 1, minWidth: 0}}>
					<div style={{fontWeight: 600, fontSize: 14}}>{boot.umbrel?.device ?? 'Umbrel'}</div>
					<div className="muted" style={{fontSize: 12.5, marginTop: 2}}>
						{boot.umbrel?.host} · {boot.umbrel?.name ?? `umbrelOS ${boot.umbrel?.version}`}
					</div>
				</div>
				<Icon name="shield" size={20} className="muted" />
			</div>
			<p className="footer-note" style={{marginTop: 14}}>
				Shows up as its own device in umbrelOS, so you can sign it out from there.
			</p>
		</main>
	)
}
