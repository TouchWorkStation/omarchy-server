// Wallpaper loading: cancel stale image loads so slow wallpapers never overwrite newer selections.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {loadWallpaper} from '../web/src/desktop/wallpaperLoader.ts'

function fakeImageFactory() {
	const created = []
	const createImage = () => {
		const img = {onload: null, onerror: null, src: ''}
		created.push(img)
		return img
	}
	return {created, createImage}
}

describe('wallpaper loader', () => {
	test('ignores slow image onload when cancelled after switching wallpapers', () => {
		const {created, createImage} = fakeImageFactory()
		const loaded = []

		const cancelA = loadWallpaper('/wall/a.jpg', {onLoad: (u) => loaded.push(u), createImage})
		const imgA = created[0]
		const savedOnloadA = imgA.onload

		cancelA()
		loadWallpaper('/wall/b.jpg', {onLoad: (u) => loaded.push(u), createImage})
		const imgB = created[1]
		imgB.onload?.()
		savedOnloadA?.()

		assert.deepEqual(loaded, ['/wall/b.jpg'])
		assert.equal(imgA.onload, null)
		assert.equal(imgA.onerror, null)
	})

	test('cancelled load does not start fallback on error', () => {
		const {created, createImage} = fakeImageFactory()
		const loaded = []

		const cancel = loadWallpaper('/api/omarchy/missing.jpg', {
			fallback: '/wall/valley.jpg',
			onLoad: (u) => loaded.push(u),
			createImage,
		})
		const savedOnerror = created[0].onerror
		cancel()
		savedOnerror?.()

		assert.equal(created.length, 1)
		assert.deepEqual(loaded, [])
	})

	test('cancelling after error started fallback ignores fallback onload', () => {
		const {created, createImage} = fakeImageFactory()
		const loaded = []

		const cancel = loadWallpaper('/api/omarchy/missing.jpg', {
			fallback: '/wall/valley.jpg',
			onLoad: (u) => loaded.push(u),
			createImage,
		})
		created[0].onerror?.()
		assert.equal(created.length, 2)
		const savedFallbackOnload = created[1].onload

		cancel()
		savedFallbackOnload?.()

		assert.deepEqual(loaded, [])
		assert.equal(created[1].onload, null)
	})

	test('uncancelled error loads fallback and invokes onLoad', () => {
		const {created, createImage} = fakeImageFactory()
		const loaded = []

		loadWallpaper('/api/omarchy/missing.jpg', {
			fallback: '/wall/valley.jpg',
			onLoad: (u) => loaded.push(u),
			createImage,
		})
		created[0].onerror?.()
		assert.equal(created[1].src, '/wall/valley.jpg')
		created[1].onload?.()

		assert.deepEqual(loaded, ['/wall/valley.jpg'])
	})
})
