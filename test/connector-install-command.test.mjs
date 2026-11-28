import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {connectorInstallCommand, connectorInstallCommandWindows} from '../web/src/swarm/installCommand.ts'

const ca = 'a'.repeat(64)
const token = 'b'.repeat(32)

test('a directory source becomes a curl URL on this server', () => {
	const server = 'https://10.1.2.3:7780'
	const got = connectorInstallCommand({
		source: '/home/joseph/code/omarchy-server',
		server,
		ca,
		token,
		allow: 'terminal,desktop,files',
	})
	assert.equal(got.command.includes('/home/joseph'), false)
	assert.match(got.command, /^curl -fsSLk https:\/\/10\.1\.2\.3:7780\/api\/connector\/install\.sh \| bash -s -- /)
	assert.match(got.command, /--server https:\/\/10\.1\.2\.3:7780 /)
	assert.match(got.command, /--source https:\/\/10\.1\.2\.3:7780\/api\/connector$/)
	assert.match(got.command, /--allow terminal,desktop,files /)
	assert.equal(got.uninstall, 'curl -fsSLk https://10.1.2.3:7780/api/connector/install.sh | bash -s -- --uninstall')
})

test('a GitHub source stays a raw URL without skipping certificate checks', () => {
	const got = connectorInstallCommand({
		source: 'https://raw.githubusercontent.com/MyOwnDataCenter/server/',
		server: 'https://10.1.2.3:7780',
		ca,
		token,
		allow: '',
	})
	assert.equal(
		got.command,
		`curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/connector/install.sh | bash -s -- --server https://10.1.2.3:7780 --ca ${ca} --token ${token} --source https://raw.githubusercontent.com/MyOwnDataCenter/server`,
	)
	assert.equal(got.command.includes(' -k'), false)
	assert.equal(got.command.includes('-fsSLk'), false)
})

test('the server hands the guest the connector files without a sign-in', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'connector-files-'))
	const connectorDir = join(dir, 'connector')
	await mkdir(connectorDir)
	await writeFile(join(connectorDir, 'install.sh'), '#!/bin/bash\necho guest-install\n')
	await writeFile(join(connectorDir, 'agent.py'), 'print("agent")\n')
	await writeFile(join(connectorDir, 'install.ps1'), 'Write-Host windows-install\n')
	const store = await createStore(dir)
	const app = createApp({store, connectorDir, relayHost: '127.0.0.1'})
	const server = await new Promise((resolve) => {
		const listening = createServer(app)
		listening.listen(0, '127.0.0.1', () => resolve(listening))
	})
	try {
		const base = `http://127.0.0.1:${server.address().port}`
		const script = await fetch(`${base}/api/connector/install.sh`)
		assert.equal(script.status, 200)
		assert.match(await script.text(), /guest-install/)
		const agent = await fetch(`${base}/api/connector/agent.py`)
		assert.equal(agent.status, 200)
		assert.match(await agent.text(), /agent/)
		const ps = await fetch(`${base}/api/connector/install.ps1`)
		assert.equal(ps.status, 200)
		assert.match(await ps.text(), /windows-install/)
		assert.equal((await fetch(`${base}/api/connector/helper.py`)).status, 404)
		assert.equal((await fetch(`${base}/api/connector/..%2Finstall.sh`)).status, 404)
	} finally {
		server.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('the installer fetches connector files from this server with its own certificate', async () => {
	const script = await readFile(new URL('../connector/install.sh', import.meta.url), 'utf8')
	assert.match(script, /\*\/api\/connector\)/)
	assert.match(script, /--cacert "\$CONF\/server-ca\.crt"/)
	assert.match(script, /fetch_connector "\$\(connector_url agent\.py\)"/)
	assert.match(script, /fetch_connector "\$\(connector_url helper\.py\)"/)
	assert.match(script, /fetch_connector "\$\(connector_url vm-helper\.py\)"/)
	assert.match(script, /fetch_connector "\$\(connector_url lxc-helper\.py\)"/)
})

test('Windows: a PowerShell command from GitHub, or from this server with the certificate pinned by the installer', async () => {
	const server = 'https://10.1.2.3:7780'
	const gh = connectorInstallCommandWindows({source: 'https://raw.githubusercontent.com/MyOwnDataCenter/server/', server, ca, token, allow: 'terminal,files'})
	assert.equal(
		gh.command,
		`$s = irm 'https://raw.githubusercontent.com/MyOwnDataCenter/server/main/connector/install.ps1'; & ([scriptblock]::Create($s)) -Server '${server}' -Ca '${ca}' -Token '${token}' -Allow 'terminal,files' -Source 'https://raw.githubusercontent.com/MyOwnDataCenter/server'`,
	)
	assert.equal(gh.command.includes('SkipCertificateCheck'), false)
	assert.match(gh.uninstall, / -Uninstall$/)
	const local = connectorInstallCommandWindows({source: '/home/joseph/code/omarchy-server', server, ca, token, allow: ''})
	assert.match(local.command, /irm -SkipCertificateCheck 'https:\/\/10\.1\.2\.3:7780\/api\/connector\/install\.ps1'/)
	assert.match(local.command, /-Source 'https:\/\/10\.1\.2\.3:7780\/api\/connector'$/)
	// The installer checks the certificate's fingerprint, and fetches the connector from this server
	// only through that certificate.
	const ps1 = await readFile(new URL('../connector/install.ps1', import.meta.url), 'utf8')
	assert.match(ps1, /fingerprint mismatch/)
	assert.match(ps1, /OmarchyPinnedFetch\]::Get\(\$AgentUrl, \$DerBytes\)/)
	assert.match(ps1, /root\.Thumbprint == ca\.Thumbprint/)
})
