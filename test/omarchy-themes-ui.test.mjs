// Omarchy themes UI state: removing a theme stops polling and leaves the Get button ready.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {isMoreThemeBusy, runThemeAction, shouldPollThemes, waitsForThemeSwitch} from '../web/src/omarchyThemesLogic.ts'

describe('omarchy themes UI state', () => {
	test('removeTheme clears pending after completion so polling stops and Get is enabled', async () => {
		let pending = null
		const setPending = (u) => {
			pending = typeof u === 'function' ? u(pending) : u
		}
		const toasts = []
		let invalidated = false

		assert.equal(waitsForThemeSwitch('omarchy.removeTheme'), false)
		assert.equal(waitsForThemeSwitch('omarchy.setTheme'), true)
		assert.equal(waitsForThemeSwitch('omarchy.installTheme'), true)

		await runThemeAction({
			path: 'omarchy.removeTheme',
			slug: 'monokai',
			done: 'Monokai removed',
			mutate: async () => {
				assert.equal(pending, 'monokai')
				assert.equal(shouldPollThemes(pending, {installed: [], more: []}), true)
			},
			invalidate: async () => {
				invalidated = true
			},
			setPending,
			toast: (msg, err) => toasts.push({msg, err: !!err}),
		})

		assert.equal(invalidated, true)
		assert.equal(pending, null)
		assert.deepEqual(toasts, [{msg: 'Monokai removed', err: false}])
		const afterData = {installed: [{slug: 'nord'}], more: [{slug: 'monokai'}]}
		assert.equal(shouldPollThemes(pending, afterData), false)
		assert.equal(isMoreThemeBusy(afterData.more[0], pending), false)
	})

	test('removeTheme still clears pending without false error toast if invalidate fails', async () => {
		let pending = null
		const setPending = (u) => {
			pending = typeof u === 'function' ? u(pending) : u
		}
		const toasts = []

		await runThemeAction({
			path: 'omarchy.removeTheme',
			slug: 'monokai',
			done: 'Monokai removed',
			mutate: async () => true,
			invalidate: async () => {
				throw new Error('network blip')
			},
			setPending,
			toast: (msg, err) => toasts.push({msg, err: !!err}),
		})

		assert.equal(pending, null)
		assert.deepEqual(toasts, [{msg: 'Monokai removed', err: false}])
	})

	test('setTheme and installTheme keep pending until theme switch completes, and errors clear it', async () => {
		let pending = null
		const setPending = (u) => {
			pending = typeof u === 'function' ? u(pending) : u
		}
		const toasts = []

		await runThemeAction({
			path: 'omarchy.installTheme',
			slug: 'monokai',
			done: 'Getting Monokai…',
			mutate: async () => true,
			invalidate: async () => {},
			setPending,
			toast: (msg, err) => toasts.push({msg, err: !!err}),
		})
		assert.equal(pending, 'monokai')
		assert.equal(isMoreThemeBusy({slug: 'monokai'}, pending), true)

		await runThemeAction({
			path: 'omarchy.setTheme',
			slug: 'bad-theme',
			mutate: async () => {
				throw new Error('broken theme')
			},
			invalidate: async () => {},
			setPending,
			toast: (msg, err) => toasts.push({msg, err: !!err}),
		})
		assert.equal(pending, null)
		assert.equal(toasts.at(-1).err, true)
		assert.equal(toasts.at(-1).msg, 'broken theme')
	})

	test('removeTheme completion does not clear pending if a newer action started', async () => {
		let pending = null
		const setPending = (u) => {
			pending = typeof u === 'function' ? u(pending) : u
		}

		await runThemeAction({
			path: 'omarchy.removeTheme',
			slug: 'monokai',
			mutate: async () => true,
			invalidate: async () => {
				pending = 'gruvbox'
			},
			setPending,
			toast: () => {},
		})
		assert.equal(pending, 'gruvbox')
	})
})
