// Ensure the top bar notifications bell rule beats generic .desk-top button styles in web/src/styles.css.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

function parseRules(css) {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
	const rules = []
	let i = 0
	let order = 0
	while (i < clean.length) {
		while (i < clean.length && /\s/.test(clean[i])) i++
		if (i >= clean.length) break
		const semi = clean.indexOf(';', i)
		const brace = clean.indexOf('{', i)
		if (brace === -1) break
		if (semi !== -1 && semi < brace) {
			i = semi + 1
			continue
		}
		const header = clean.slice(i, brace).trim()
		let depth = 1
		let j = brace + 1
		while (j < clean.length && depth > 0) {
			if (clean[j] === '{') depth++
			else if (clean[j] === '}') depth--
			j++
		}
		const body = clean.slice(brace + 1, j - 1)
		i = j
		if (header.startsWith('@')) continue
		const decls = {}
		for (const part of body.split(';')) {
			const colon = part.indexOf(':')
			if (colon === -1) continue
			const prop = part.slice(0, colon).trim().toLowerCase()
			const val = part.slice(colon + 1).trim()
			if (prop) decls[prop] = val
		}
		for (const sel of header.split(',')) {
			const s = sel.trim()
			if (s) rules.push({selector: s, decls, order: order++})
		}
	}
	return rules
}

// Matches a selector against <button class="..."> inside <header class="desk-top"> inside an optional root container.
function matchBellSelector(selector, buttonClasses, rootClasses = new Set()) {
	if (/[:\[>+~]/.test(selector)) return null
	const parts = selector.trim().split(/\s+/)
	const targetPart = parts[parts.length - 1]
	const ancestorParts = parts.slice(0, -1)

	const matchPart = (part, tag, classes) => {
		const m = part.match(/^(?:([a-zA-Z0-9_-]+))?((?:\.[a-zA-Z0-9_-]+)*)$/)
		if (!m) return null
		const [, elTag, clsStr] = m
		if (elTag && elTag !== tag) return null
		const cls = clsStr ? clsStr.slice(1).split('.') : []
		if (!cls.every((c) => classes.has(c))) return null
		return [0, cls.length, elTag ? 1 : 0]
	}

	const targetSpec = matchPart(targetPart, 'button', buttonClasses)
	if (!targetSpec) return null

	let total = [...targetSpec]
	if (ancestorParts.length === 0) return total
	if (ancestorParts.length === 1) {
		const ancSpec = matchPart(ancestorParts[0], 'header', new Set(['desk-top']))
		if (!ancSpec) return null
		return [total[0] + ancSpec[0], total[1] + ancSpec[1], total[2] + ancSpec[2]]
	}
	if (ancestorParts.length === 2) {
		const rootSpec = matchPart(ancestorParts[0], 'div', rootClasses)
		const ancSpec = matchPart(ancestorParts[1], 'header', new Set(['desk-top']))
		if (!rootSpec || !ancSpec) return null
		return [
			total[0] + rootSpec[0] + ancSpec[0],
			total[1] + rootSpec[1] + ancSpec[1],
			total[2] + rootSpec[2] + ancSpec[2],
		]
	}
	return null
}

function cmpSpec(a, b) {
	for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] - b[k]
	return 0
}

function computeBellStyles(buttonClasses, rootClasses = new Set()) {
	const rules = parseRules(CSS)
	const resolved = {}
	for (const r of rules) {
		const spec = matchBellSelector(r.selector, buttonClasses, rootClasses)
		if (!spec) continue
		for (const [prop, value] of Object.entries(r.decls)) {
			const prev = resolved[prop]
			if (!prev || cmpSpec(spec, prev.spec) >= 0) {
				resolved[prop] = {value, spec, order: r.order}
			}
		}
	}
	return Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.value]))
}

describe('desktop top bar bell styles', () => {
	test('.desk-top .top-bell wins padding, display, width, and color over .desk-top button', () => {
		const bell = computeBellStyles(new Set(['top-bell']))
		assert.equal(bell.padding, '0')
		assert.equal(bell.display, 'inline-grid')
		assert.equal(bell.width, '30px')
		assert.equal(bell.color, 'rgba(255, 255, 255, 0.82)')

		const lit = computeBellStyles(new Set(['top-bell', 'lit']))
		assert.equal(lit.color, 'var(--accent-text)')
	})

	test('.style-daylight .desk-top .top-bell uses dark ink while preserving .lit accent color', () => {
		const daylight = new Set(['style-daylight'])
		const bell = computeBellStyles(new Set(['top-bell']), daylight)
		assert.equal(bell.color, 'rgba(0, 0, 0, 0.62)')

		const lit = computeBellStyles(new Set(['top-bell', 'lit']), daylight)
		assert.equal(lit.color, 'var(--accent-text)')
	})
})
