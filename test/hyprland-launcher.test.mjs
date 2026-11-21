// Hyprland launcher: keep keyboard selection bounded and scrolled into view.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {scrollSelectedRow, stepLauncherSelection} from '../web/src/desktop/hyprland/launcherScroll.ts'

describe('hyprland launcher selection and scroll', () => {
	test('stepLauncherSelection bounds indices and avoids -1 when list is empty', () => {
		assert.equal(stepLauncherSelection(0, 'ArrowDown', 0), 0)
		assert.equal(stepLauncherSelection(0, 'ArrowUp', 0), 0)
		assert.equal(stepLauncherSelection(0, 'ArrowDown', 5), 1)
		assert.equal(stepLauncherSelection(4, 'ArrowDown', 5), 4)
		assert.equal(stepLauncherSelection(0, 'ArrowUp', 5), 0)
		assert.equal(stepLauncherSelection(3, 'ArrowUp', 5), 2)
	})

	test('scrollSelectedRow scrolls the active row into view with block: nearest', () => {
		const calls = []
		const children = [0, 1, 2, 3].map((i) => ({
			scrollIntoView(opts) {
				calls.push({i, opts})
			},
		}))
		const list = {children}

		assert.equal(scrollSelectedRow(list, 2, 4), true)
		assert.deepEqual(calls, [{i: 2, opts: {block: 'nearest'}}])

		calls.length = 0
		assert.equal(scrollSelectedRow(list, 10, 4), true)
		assert.deepEqual(calls, [{i: 3, opts: {block: 'nearest'}}])

		calls.length = 0
		assert.equal(scrollSelectedRow(list, 0, 0), false)
		assert.equal(scrollSelectedRow(null, 0, 4), false)
		assert.deepEqual(calls, [])
	})
})
