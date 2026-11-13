#!/usr/bin/env node
// Install the npm packages only when they changed. `npm ci` deletes and reinstalls everything,
// which needs a lot of memory; most updates change no packages at all (a version bump touches
// package-lock.json, so the stamp is a hash of the packages alone, not of the whole file).
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const packages = {...lock.packages}
if (packages['']) packages[''] = {...packages[''], version: undefined, name: undefined}
const hash = createHash('sha256').update(JSON.stringify(packages)).digest('hex')
const stamp = join(root, 'node_modules', '.omarchy-packages')

if (process.argv.includes('--check')) process.exit(existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash ? 0 : 1)
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) {
	console.log('Packages unchanged')
	process.exit(0)
}
// Fewer parallel downloads keeps memory down on small machines.
const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error', '--maxsockets=4'], {cwd: root, stdio: 'inherit'})
if (r.status !== 0) {
	if (r.signal === 'SIGKILL' || r.status === 137) console.error('npm was stopped because the computer ran out of memory.')
	process.exit(r.status || 1)
}
writeFileSync(stamp, hash + '\n')
