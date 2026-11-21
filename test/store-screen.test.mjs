import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {remainingSuggestedStores} from '../web/src/storeSuggestions.ts'

test('Store does not define Item inside its render body', async () => {
	const src = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	const storeStart = src.indexOf('export function Store(')
	const storeEnd = src.indexOf('// ---- community app stores')
	assert.ok(storeStart >= 0 && storeEnd > storeStart)
	const storeBody = src.slice(storeStart, storeEnd)
	assert.doesNotMatch(storeBody, /\b(?:const|function)\s+Item\b/)
	assert.match(src, /\nfunction StoreItem\(/)
	assert.match(storeBody, /<StoreItem\b/)
})
test('CommunityStores hides TouchWorkStation when replaced by a local store', async () => {
	const tws = {url: 'https://github.com/TouchWorkStation/app-store', name: 'TouchWorkStation', blurb: 'browsers'}
	assert.equal(remainingSuggestedStores([tws], []).length, 1)
	assert.equal(remainingSuggestedStores([tws], [{url: 'https://github.com/example/other', meta: {id: 'other', name: 'Other'}}]).length, 1)
	assert.equal(remainingSuggestedStores([tws], [{url: 'https://github.com/TouchWorkStation/app-store.git/', meta: {id: 'tws', name: 'TWS'}}]).length, 0)
	assert.equal(
		remainingSuggestedStores([tws], [{url: 'file:///tmp/app-store', meta: {id: 'local', name: 'Local'}, replaces: 'https://github.com/TouchWorkStation/app-store'}]).length,
		0,
	)

	const src = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	assert.match(src, /remainingSuggestedStores\(SUGGESTED_STORES/)
})
