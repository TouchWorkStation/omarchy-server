#!/usr/bin/env node
// omarchy-server [--backend <address>] [--port 7780] [--host 0.0.0.0] [--data <dir>] [--app-hosts <pattern|off>]
import http from 'node:http'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'

import {createApp, normalizeAppHosts, normalizeBackendUrl, startupUrls, VERSION} from './app.mjs'
import {createStore} from './store.mjs'
import {formatDataDirError, parsePort} from '../omarchyd/cli-args.mjs'
import {defaultTlsDir, dualProtocolServer, tlsContext} from '../omarchyd/tls.mjs'

let values
try {
	const parsed = parseArgs({
		strict: true,
		allowPositionals: false,
		options: {
			backend: {type: 'string'},
			port: {type: 'string'},
			host: {type: 'string'},
			data: {type: 'string'},
			'app-hosts': {type: 'string'},
			'remote-port': {type: 'string'},
			help: {type: 'boolean', short: 'h'},
		},
	})
	values = parsed.values
} catch (error) {
	console.error(`[omarchy-server] ${error.message}`)
	console.error('Run with --help for usage.')
	process.exit(2)
}

if (values.help) {
	console.log(`MODC ${VERSION}

  omarchy-server [--backend <address>] [--port <n>] [--host <addr>] [--data <dir>] [--app-hosts <pattern|off>]

  --backend    Address of omarchyd, the backend (default http://127.0.0.1:2021 when set by installer, env OMARCHY_BACKEND_URL)
  --port       Port to listen on (default 7780, env PORT)
  --host       Address to bind (default 0.0.0.0, env HOST)
  --data       Where config and device sessions live (default ~/.config/omarchy-server, env OMARCHY_SERVER_DATA)
  --app-hosts  App subdomain pattern, e.g. "{app}-touch.example.com" ("off" or "" to clear, env TOUCH_APP_HOSTS)
  --remote-port  Remote-access listener for cloudflared on 127.0.0.1 (default 7781, "off" for none, env OMARCHY_REMOTE_PORT)
  -h, --help   Show this help

Environment:
  OMARCHY_SERVER_SECURE_COOKIES=1  Mark the session cookie Secure (when served only behind HTTPS)`)
	process.exit(0)
}

let port
try {
	port = parsePort(values.port, process.env.PORT, {flag: '--port', env: 'PORT', fallback: 7780})
} catch (error) {
	console.error(`[omarchy-server] ${error.message}`)
	process.exit(1)
}
const host = values.host || process.env.HOST || '0.0.0.0'
const dataFromFlag = values.data !== undefined
const dataDir = dataFromFlag ? values.data : process.env.OMARCHY_SERVER_DATA || join(homedir(), '.config', 'omarchy-server')
if (!String(dataDir).trim()) {
	console.error(`[omarchy-server] ${dataFromFlag ? '--data' : 'OMARCHY_SERVER_DATA'} cannot be empty`)
	process.exit(1)
}
const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const backendFromFlag = values.backend !== undefined
const backendArg = backendFromFlag ? values.backend : process.env.OMARCHY_BACKEND_URL || undefined
let backendUrl
if (backendArg !== undefined) {
	try {
		backendUrl = normalizeBackendUrl(backendArg)
	} catch (error) {
		const label = backendFromFlag ? '--backend' : 'OMARCHY_BACKEND_URL'
		const message = error?.code === 'ERR_INVALID_URL' ? 'that is not a valid address' : error.message
		console.error(`[omarchy-server] ${label}: ${message}`)
		process.exit(1)
	}
}
// App addresses for remote access, e.g. "{app}-touch.example.com"; kept until set to "off" or "".
const appHostsFromFlag = values['app-hosts'] !== undefined
const rawAppHosts = appHostsFromFlag ? values['app-hosts'] : process.env.TOUCH_APP_HOSTS
let appHostsUpdate
if (rawAppHosts !== undefined) {
	try {
		appHostsUpdate = normalizeAppHosts(rawAppHosts)
	} catch (error) {
		const label = appHostsFromFlag ? '--app-hosts' : 'TOUCH_APP_HOSTS'
		console.error(`[omarchy-server] ${label} ${error.message}`)
		process.exit(2)
	}
}

let store
try {
	store = await createStore(dataDir)
	if (backendUrl !== undefined) await store.setConfig({backendUrl})
	if (rawAppHosts !== undefined) await store.setConfig({appHosts: appHostsUpdate})
} catch (error) {
	console.error(`[omarchy-server] ${formatDataDirError(dataDir, error)}`)
	process.exit(1)
}

// https:// on the same port as http:// (see omarchyd/tls.mjs). The certificate is shared with omarchyd.
const secure = tlsContext({dir: defaultTlsDir()})
const app = createApp({store, staticDir, tls: secure, secureCookies: process.env.OMARCHY_SERVER_SECURE_COOKIES === '1', relayHost: host})
const httpServer = http.createServer(app)
const server = dualProtocolServer(httpServer, secure.get)
server.listen(port, host, () => {
	console.log(`\n  MODC ${VERSION}`)
	console.log(`  Backend   ${store.getConfig().backendUrl ?? '(not set: open the app to connect)'}`)
	console.log(`  Data      ${dataDir}`)
	for (const url of startupUrls(host, port)) console.log(`  Open      ${url}`)
	console.log('')
})
app.attachConsole(httpServer)

// MODC Connect remote ingress: 127.0.0.1 only, plain HTTP, for cloudflared. Every request on it must
// pass the remote-access gate (Cloudflare Access token, remote access on); the listener above, for
// this network, is unchanged.
const rawRemote = values['remote-port'] ?? process.env.OMARCHY_REMOTE_PORT ?? '7781'
let remoteServer = null
if (String(rawRemote).trim().toLowerCase() !== 'off') {
	let remotePort
	try {
		remotePort = parsePort(rawRemote, undefined, {flag: '--remote-port', env: 'OMARCHY_REMOTE_PORT', fallback: 7781})
	} catch (error) {
		console.error(`[omarchy-server] ${error.message}`)
		process.exit(1)
	}
	remoteServer = http.createServer(app)
	app.attachRemote(remoteServer)
	remoteServer.on('error', (error) => console.error(`[omarchy-server] remote-access listener: ${error.message} (remote access through it is unavailable; everything else works)`))
	remoteServer.listen(remotePort, '127.0.0.1', () => console.log(`  Remote    http://127.0.0.1:${remotePort} (cloudflared only; Access-protected)`))
}
server.on('error', (error) => {
	console.error(`[omarchy-server] ${error.message}`)
	process.exit(1)
})
// Stopping (a restart, an update): stop taking new connections, say goodbye to the open ones, and
// don't wait on a browser that keeps its WebSocket open. 5 seconds at most, whatever happens.
let stopping = false
function stop() {
	if (stopping) return
	stopping = true
	setTimeout(() => process.exit(0), 5000).unref()
	server.close(() => process.exit(0))
	remoteServer?.close()
	remoteServer?.closeAllConnections?.()
	app.closeAll()
	httpServer.closeIdleConnections?.()
	setTimeout(() => server.destroyConnections(), 1000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
