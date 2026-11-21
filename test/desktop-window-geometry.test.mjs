// Desktop window geometry: keep restored and resized windows inside the visible work area.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {TITLE_BAR_HEIGHT, clampDragY, clampWindowRect} from '../web/src/desktop/windowGeometry.ts'
import {BIG} from '../web/src/layout.ts'

describe('desktop window geometry', () => {
	test('clamps oversized or off-screen window saved at 1920x1080 when viewport shrinks to 1000x600', () => {
		const workArea = {x: 74, y: 34, w: 926, h: 566}
		const saved = {x: 1200, y: 900, w: 960, h: 660}
		const r = clampWindowRect(saved, workArea)

		assert.equal(TITLE_BAR_HEIGHT, 42)
		assert.ok(r.w <= workArea.w)
		assert.ok(r.h <= workArea.h)
		assert.ok(r.x >= workArea.x)
		assert.ok(r.x + r.w <= workArea.x + workArea.w)
		assert.ok(r.y >= workArea.y)
		assert.ok(r.y + TITLE_BAR_HEIGHT <= workArea.y + workArea.h)
	})

	test('pulls a window saved at y=700 back onto an 860x560 desktop', () => {
		const workArea = {x: 74, y: 34, w: BIG.down - 74, h: BIG.height - 34}
		const r = clampWindowRect({x: 120, y: 700, w: 500, h: 400}, workArea)

		assert.ok(r.y >= workArea.y)
		assert.ok(r.y + TITLE_BAR_HEIGHT <= workArea.y + workArea.h)
	})

	test('clamps negative or above-topbar coordinates to workArea origin', () => {
		const workArea = {x: 74, y: 34, w: 1200, h: 700}
		const r = clampWindowRect({x: 10, y: 0, w: 600, h: 400}, workArea)

		assert.equal(r.x, workArea.x)
		assert.equal(r.y, workArea.y)
	})

	test('keeps title bar above a bottom dock and leaves fitting windows unchanged', () => {
		const bottomDockArea = {x: 0, y: 34, w: 1440, h: 794}
		const offBottom = clampWindowRect({x: 100, y: 820, w: 600, h: 400}, bottomDockArea)
		assert.equal(offBottom.y, bottomDockArea.y + bottomDockArea.h - TITLE_BAR_HEIGHT)

		const fitting = {x: 120, y: 80, w: 700, h: 500}
		assert.deepEqual(clampWindowRect(fitting, bottomDockArea), fitting)
	})

	test('clampDragY keeps dragged title bar above bottom dock and below top bar/top dock', () => {
		const bottomDockArea = {x: 0, y: 34, w: 1440, h: 794} // 900px tall viewport - 34px top bar - 72px bottom dock
		const y = clampDragY(850, bottomDockArea)
		assert.equal(y, 786)
		assert.ok(y + TITLE_BAR_HEIGHT <= bottomDockArea.y + bottomDockArea.h)

		assert.equal(clampDragY(0, bottomDockArea), 34)
		assert.equal(clampDragY(20, {x: 0, y: 106, w: 1440, h: 794}), 106)
		assert.equal(clampDragY(90, {x: 0, y: 34, w: 400, h: 30}), 34)
	})
})
