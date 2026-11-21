// Desktop top bar clock aligns refreshes to exact minute boundaries.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {msUntilNextMinute, startMinuteClock} from '../web/src/desktop/clock.ts'

describe('desktop top bar clock', () => {
	test('msUntilNextMinute computes delay to next minute boundary and never returns 0', () => {
		const base = Date.UTC(2026, 10, 20, 12, 0, 0, 0)
		assert.equal(msUntilNextMinute(base + 45_000), 15_000)
		assert.equal(msUntilNextMinute(base + 59_999), 1)
		assert.equal(msUntilNextMinute(base), 60_000)
		assert.equal(msUntilNextMinute(base + 1), 59_999)
	})

	test('startMinuteClock aligns to minute boundaries, handles early wakeup, and cleans up on stop', () => {
		let currentMs = Date.UTC(2026, 10, 20, 12, 0, 45, 0)
		let nextId = 1
		const scheduled = new Map()
		const cleared = []
		const ticks = []

		const stop = startMinuteClock((d) => ticks.push(d.getTime()), {
			now: () => currentMs,
			setTimer: (fn, ms) => {
				const id = nextId++
				scheduled.set(id, {fn, ms})
				return id
			},
			clearTimer: (id) => {
				cleared.push(id)
				scheduled.delete(id)
			},
		})

		assert.equal(scheduled.size, 1)
		const first = scheduled.get(1)
		assert.equal(first.ms, 15_000)

		// Early timer wakeup 2ms before the minute boundary reschedules for the remaining 2ms.
		scheduled.delete(1)
		currentMs = Date.UTC(2026, 10, 20, 12, 0, 59, 998)
		first.fn()
		assert.deepEqual(ticks, [])
		assert.equal(scheduled.get(2)?.ms, 2)

		// Exact minute boundary emits tick and schedules full 60s to the next minute.
		const second = scheduled.get(2)
		scheduled.delete(2)
		currentMs = Date.UTC(2026, 10, 20, 12, 1, 0, 0)
		second.fn()
		assert.deepEqual(ticks, [Date.UTC(2026, 10, 20, 12, 1, 0, 0)])
		const third = scheduled.get(3)
		assert.equal(third?.ms, 60_000)

		// Calling stop cancels the pending timer and suppresses any further ticks.
		stop()
		assert.deepEqual(cleared, [3])
		assert.equal(scheduled.size, 0)
		currentMs = Date.UTC(2026, 10, 20, 12, 2, 0, 0)
		third.fn()
		assert.equal(ticks.length, 1)
	})
})
