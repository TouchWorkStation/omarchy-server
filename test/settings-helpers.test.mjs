// Settings sheet copy and helper checks.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'

import {PASSWORD_SHEET_SUBTITLE} from '../web/src/screens/settingsHelpers.ts'

describe('settings helpers', () => {
	test('password sheet subtitle names Omarchy Server once', () => {
		assert.equal(PASSWORD_SHEET_SUBTITLE, 'Used to sign in to Omarchy Server')
		assert.equal(PASSWORD_SHEET_SUBTITLE.match(/Omarchy Server/g)?.length, 1)

		const settingsSrc = readFileSync(new URL('../web/src/screens/Settings.tsx', import.meta.url), 'utf8')
		assert.equal(settingsSrc.includes('Used for Omarchy Server and Omarchy Server'), false)
		assert.equal(settingsSrc.includes('subtitle={PASSWORD_SHEET_SUBTITLE}'), true)
	})
})
