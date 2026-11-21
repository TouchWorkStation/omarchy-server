import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {storageRowSub} from '../web/src/swarm/storageHint.ts'

test('storageRowSub shows active text when allowed and on', () => {
	assert.equal(storageRowSub(true, true), 'Drives, format extra disks, and pools on this computer')
})

test('storageRowSub says Storage is switched off here when allowed but off', () => {
	const sub = storageRowSub(true, false)
	assert.equal(sub, 'Switched off here. Turn Storage on under Allowed here.')
	assert.doesNotMatch(sub, /Pair this computer again/)
})

test('storageRowSub asks to pair again only when Storage was not allowed', () => {
	assert.equal(storageRowSub(false, false), 'Pair this computer again with Storage switched on.')
	assert.equal(storageRowSub(false, true), 'Pair this computer again with Storage switched on.')
})

test('Swarm.tsx uses storageRowSub while keeping offline check intact', async () => {
	const src = await readFile(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	assert.match(src, /import \{storageRowSub\} from '\.\/storageHint'/)
	assert.match(src, /sub=\{offline \? undefined : storageRowSub\(a\.allowed\.storage, a\.on\.storage\)\}/)
})
