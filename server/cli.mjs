#!/usr/bin/env node
// omarchy-server [--backend <address>] [--port 7780] [--host 0.0.0.0] [--data <dir>]
import {networkInterfaces, homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {createApp, normalizeBackendUrl, VERSION} from './app.mjs'
import {createStore} from './store.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : undefined
}
if (args.includes('--help') || args.includes('-h')) {
	console.log(`Omarchy Server ${VERSION}

  omarchy-server [--backend <address>] [--port <n>] [--host <addr>] [--data <dir>]

  --backend  Address of omarchyd, the backend (the installer sets http://127.0.0.1:2021)
  --port    Port to listen on (default 7780, env PORT)
  --host    Address to bind (default 0.0.0.0, env HOST)
  --data    Where config and device sessions live (default ~/.config/omarchy-server)`)
	process.exit(0)
}

const port = Number(flag('port') ?? process.env.PORT ?? 7780)
const host = flag('host') ?? process.env.HOST ?? '0.0.0.0'
const dataDir = flag('data') ?? process.env.OMARCHY_SERVER_DATA ?? join(homedir(), '.config', 'omarchy-server')
const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const store = await createStore(dataDir)
const backendArg = flag('backend') ?? process.env.OMARCHY_BACKEND_URL
if (backendArg) await store.setConfig({backendUrl: normalizeBackendUrl(backendArg)})
// App addresses for remote access, e.g. "{app}-touch.example.com"; kept until set to "off".
const appHosts = flag('app-hosts') ?? process.env.TOUCH_APP_HOSTS
if (appHosts) await store.setConfig({appHosts: appHosts === 'off' ? null : appHosts})

const app = createApp({store, staticDir, secureCookies: process.env.OMARCHY_SERVER_SECURE_COOKIES === '1'})
const server = app.listen(port, host, () => {
	const lan = Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && i.family === 'IPv4' && !i.internal)
		.map((i) => `http://${i.address}:${port}`)
	console.log(`\n  Omarchy Server ${VERSION}`)
	console.log(`  Backend   ${store.getConfig().backendUrl ?? '(not set: open the app to connect)'}`)
	console.log(`  Data      ${dataDir}`)
	for (const url of lan.length ? lan : [`http://localhost:${port}`]) console.log(`  Open      ${url}`)
	console.log('')
})
app.attachConsole(server)
server.on('error', (error) => {
	console.error(`[omarchy-server] ${error.message}`)
	process.exit(1)
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
