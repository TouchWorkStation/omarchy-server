#!/usr/bin/env node
// omarchyd serve [--port 2021] [--data DIR]       run the backend (localhost only)
// omarchyd create-owner [--name NAME] [--data DIR]  create the owner account; asks for the password here
import os from 'node:os'
import {join} from 'node:path'
import {parseArgs} from 'node:util'

import {openAccounts} from './accounts.mjs'
import {startOmarchyd} from './server.mjs'

const {values, positionals} = parseArgs({
	allowPositionals: true,
	options: {port: {type: 'string', default: '2021'}, data: {type: 'string'}, name: {type: 'string'}},
})
const dataDir = values.data ?? join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'omarchy-server')
const command = positionals[0] ?? 'serve'

// Read a password from the terminal without echoing it.
function askHidden(prompt) {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin
		if (!stdin.isTTY) return reject(new Error('Run this in a terminal so the password can be typed privately'))
		process.stdout.write(prompt)
		stdin.setRawMode(true)
		stdin.resume()
		stdin.setEncoding('utf8')
		let value = ''
		const onData = (ch) => {
			if (ch === '\u0003') {
				stdin.setRawMode(false)
				process.stdout.write('\n')
				process.exit(130)
			}
			if (ch === '\r' || ch === '\n') {
				stdin.setRawMode(false)
				stdin.pause()
				stdin.off('data', onData)
				process.stdout.write('\n')
				return resolve(value)
			}
			if (ch === '\u007f') value = value.slice(0, -1)
			else value += ch
		}
		stdin.on('data', onData)
	})
}

if (command === 'serve') {
	if (process.getuid?.() === 0 && process.env.OMARCHYD_ALLOW_ROOT !== '1') {
		console.error('omarchyd runs as your own user, not root. Start it without sudo.')
		process.exit(1)
	}
	const server = await startOmarchyd({port: Number(values.port), dataDir})
	console.log(`omarchyd listening on ${server.url} (data in ${dataDir})`)
	if (!server.accounts.hasOwner()) console.log('No owner yet. Create one with: omarchyd create-owner')
} else if (command === 'create-owner') {
	const accounts = await openAccounts(dataDir)
	if (accounts.hasOwner()) {
		console.error('An owner account already exists.')
		process.exit(1)
	}
	const name = values.name ?? os.userInfo().username
	const password = await askHidden(`Password for ${name}: `)
	const again = await askHidden('Again: ')
	if (password !== again) {
		console.error('The passwords don’t match.')
		process.exit(1)
	}
	try {
		await accounts.createOwner({name, password})
		console.log(`Created the owner account “${name}”. Sign in with that name and password.`)
	} catch (e) {
		console.error(e.message)
		process.exit(1)
	}
} else {
	console.error(`Unknown command “${command}”. Use: serve | create-owner`)
	process.exit(1)
}
