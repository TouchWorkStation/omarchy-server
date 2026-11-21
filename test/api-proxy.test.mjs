// The published job API refuses anonymous calls, and streams a response without waiting for the end.
import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile, chmod} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'

const proxy = fileURLToPath(new URL('../omarchyd/api-proxy', import.meta.url))
const shimSrc = fileURLToPath(new URL('../omarchyd/bind-localhost.c', import.meta.url))

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const {port} = server.address()
			server.close(() => resolve(port))
		})
	})
}

function call(port, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request({host: '127.0.0.1', port, path: '/jobs', method: 'POST', headers: {'content-type': 'application/json', ...headers}}, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}))
		})
		req.on('error', reject)
		req.end('{}')
	})
}

test('the job API requires its token, and the web port also accepts the sign-in gateway', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-api-proxy-'))
	const fake = join(root, 'app')
	const report = join(root, 'bind')
	const hits = join(root, 'hits')
	const shim = join(root, 'bind.so')
	let gcc = true
	try {
		execFileSync('gcc', ['-shared', '-fPIC', '-o', shim, shimSrc, '-ldl'], {stdio: 'ignore'})
	} catch {
		gcc = false
	}
	await writeFile(fake, `#!/usr/bin/env python3
import os, socket, time
port = int(os.environ["PORT"])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", port))
open(os.environ["BIND_REPORT"], "w").write(s.getsockname()[0] + "\\n")
s.listen(16)
while True:
    c, _ = s.accept()
    data = b""
    while b"\\r\\n\\r\\n" not in data:
        chunk = c.recv(65536)
        if not chunk:
            break
        data += chunk
    with open(os.environ["HIT_FILE"], "a") as handle:
        handle.write("hit\\n")
    if b"x-slow:" in data.split(b"\\r\\n\\r\\n", 1)[0].lower():
        c.sendall(b"HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream\\r\\nTransfer-Encoding: chunked\\r\\nConnection: close\\r\\n\\r\\n5\\r\\ndata\\n\\r\\n")
        time.sleep(1.2)
        c.sendall(b"4\\r\\nend\\n\\r\\n0\\r\\n\\r\\n")
    else:
        c.sendall(b"HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok")
    c.close()
`)
	await chmod(fake, 0o755)
	const [web, api, child] = [await freePort(), await freePort(), await freePort()]
	const proc = spawn('python3', [proxy], {
		env: {...process.env, WEB_PORT: String(web), API_PORT: String(api), CHILD_PORT: String(child), OMARCHY_API_TOKEN: 'job-token', APP_GATEWAY_KEY: 'gate-key', OMARCHY_APP: fake, OMARCHY_BIND_SHIM: gcc ? shim : join(root, 'missing.so'), BIND_REPORT: report, HIT_FILE: hits},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let log = ''
	proc.stdout.on('data', (chunk) => { log += chunk })
	proc.stderr.on('data', (chunk) => { log += chunk })
	try {
		const ready = Date.now() + 5000
		while (!log.includes('job API on') || !(await readFile(report, 'utf8').catch(() => ''))) {
			if (proc.exitCode !== null) throw new Error(`proxy exited ${proc.exitCode}: ${log}`)
			if (Date.now() > ready) throw new Error(`proxy did not start: ${log}`)
			await new Promise((r) => setTimeout(r, 20))
		}
		const bound = (await readFile(report, 'utf8')).trim()
		if (gcc) assert.equal(bound, '127.0.0.1')
		const refused = await call(api, {})
		assert.equal(refused.status, 401)
		assert.equal(await readFile(hits, 'utf8').catch(() => ''), '')
		const wrong = await call(api, {authorization: 'Bearer nope'})
		assert.equal(wrong.status, 401)
		const gatewayOnApi = await call(api, {'x-omarchy-gateway': 'gate-key'})
		assert.equal(gatewayOnApi.status, 401)
		const allowed = await call(api, {authorization: 'Bearer job-token'})
		assert.equal(allowed.status, 200)
		assert.equal(allowed.body, 'ok')
		assert.equal((await readFile(hits, 'utf8')).trim().split('\n').length, 1)
		const webRefused = await call(web, {})
		assert.equal(webRefused.status, 401)
		const webGate = await call(web, {'x-omarchy-gateway': 'gate-key'})
		assert.equal(webGate.status, 200)
		assert.equal(webGate.body, 'ok')
		const webToken = await call(web, {authorization: 'Bearer job-token'})
		assert.equal(webToken.status, 200)
		const started = Date.now()
		const first = await new Promise((resolve, reject) => {
			const req = http.request({host: '127.0.0.1', port: api, path: '/events', method: 'GET', headers: {authorization: 'Bearer job-token', 'x-slow': '1'}}, (res) => {
				res.once('data', (chunk) => resolve({status: res.statusCode, text: chunk.toString(), ms: Date.now() - started}))
			})
			req.on('error', reject)
			req.end()
		})
		assert.equal(first.status, 200)
		assert.match(first.text, /data/)
		assert.ok(first.ms < 800, `first byte took ${first.ms}ms`)
	} finally {
		proc.kill('SIGTERM')
		await new Promise((resolve) => proc.once('exit', resolve))
		await rm(root, {recursive: true, force: true})
	}
})
