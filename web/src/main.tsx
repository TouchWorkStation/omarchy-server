import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {App} from './App'
import {ApiError} from './api'
import {Providers, applyPrefs, readPrefs, watchKeyboardViewport, watchStandaloneGap} from './ui'
import './styles.css'

applyPrefs(readPrefs())
watchKeyboardViewport()
watchStandaloneGap()

const client = new QueryClient({
	defaultOptions: {
		queries: {
			// Don't hammer umbreld with retries for auth or permission errors.
			retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
			refetchOnWindowFocus: true,
			staleTime: 2000,
		},
	},
})

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={client}>
			<Providers>
				<App />
			</Providers>
		</QueryClientProvider>
	</StrictMode>,
)

// A home-screen app on iPhone can stay alive for days and keep running an old build after Touch updates.
// When the page comes back to the foreground, ask the server which version it runs and reload if it's newer.
async function reloadIfUpdated() {
	try {
		const r = await fetch('/api/bootstrap', {credentials: 'same-origin', cache: 'no-store'})
		const v = (await r.json())?.touch?.version
		if (!v || v === __TOUCH_BUILD__) return
		const key = `touch.reloadedFor.${v}`
		if (sessionStorage.getItem(key)) return
		sessionStorage.setItem(key, '1')
		location.reload()
	} catch {}
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void reloadIfUpdated())
window.addEventListener('pageshow', (e) => e.persisted && void reloadIfUpdated())
void reloadIfUpdated()

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
	window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
