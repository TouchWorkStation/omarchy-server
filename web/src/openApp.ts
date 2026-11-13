import {mutate, query, type UserApp} from './api'

type Probe = {result: string; status?: number}
const answered = (p: Probe | null) => p?.result === 'answered' && (p.status ?? 500) < 500

// Go to an app's own address, like clicking a container's link in Docker. If the app isn't
// answering yet (still starting, as Home Assistant often is for its first minute), wait for it
// first, so the tab doesn't land on a dead page. `onWaiting` is told while it waits.
export async function openApp(app: UserApp, url: string, {onWaiting, signal}: {onWaiting?: (seconds: number) => void; signal?: AbortSignal} = {}) {
	mutate('apps.trackOpen', {appId: app.id}).catch(() => {})
	const started = Date.now()
	for (;;) {
		if (signal?.aborted) return false
		const p = await query<Probe>('apps.probe', {appId: app.id}).catch(() => null)
		// Couldn't ask (older server, network): just go.
		if (p === null || answered(p) || p.result === 'no-web') break
		const waited = Math.round((Date.now() - started) / 1000)
		if (waited > 180) break // go anyway: the app's own page says what's wrong
		onWaiting?.(waited)
		await new Promise((r) => setTimeout(r, 2000))
	}
	if (signal?.aborted) return false
	location.assign(url)
	return true
}
