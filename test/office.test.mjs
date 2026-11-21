import assert from 'node:assert/strict'
import {after, before, test} from 'node:test'
import JSZip from 'jszip'

import {cleanNum, decodeCp437, listZip, readPptx, readXlsx} from '../web/src/screens/viewer/office.ts'

const unescapeXml = (s) =>
	s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e) => {
		if (e === 'lt') return '<'
		if (e === 'gt') return '>'
		if (e === 'amp') return '&'
		if (e === 'quot') return '"'
		if (e === 'apos') return "'"
		if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
		return String.fromCodePoint(parseInt(e.slice(1), 10))
	})

class XmlElement {
	constructor(tag, attrs, nsMap, parent) {
		this.tagName = tag
		const colon = tag.indexOf(':')
		this.localName = colon >= 0 ? tag.slice(colon + 1) : tag
		this.attrs = attrs
		this.nsMap = nsMap
		this.parent = parent
		this.children = []
		this.parts = []
	}
	getAttribute(name) {
		return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null
	}
	getAttributeNS(nsUri, local) {
		for (const [k, v] of Object.entries(this.attrs)) {
			const c = k.indexOf(':')
			if (c < 0) continue
			if (k.slice(c + 1) !== local) continue
			const prefix = k.slice(0, c)
			if (this.nsMap[prefix] === nsUri) return v
		}
		return null
	}
	getElementsByTagNameNS(_ns, local) {
		const out = []
		const walk = (el) => {
			for (const ch of el.children) {
				if (local === '*' || ch.localName === local) out.push(ch)
				walk(ch)
			}
		}
		walk(this)
		return out
	}
	get textContent() {
		return this.parts.map((p) => (typeof p === 'string' ? p : p.textContent)).join('')
	}
}

class XmlDocument {
	constructor(root) {
		this.root = root
		this.children = root ? [root] : []
	}
	getElementsByTagNameNS(_ns, local) {
		if (!this.root) return []
		const out = local === '*' || this.root.localName === local ? [this.root] : []
		return out.concat(this.root.getElementsByTagNameNS(_ns, local))
	}
}

class SimpleDOMParser {
	parseFromString(src) {
		const rootHolder = new XmlElement('__root__', {}, {}, null)
		const stack = [rootHolder]
		let i = 0
		const len = src.length
		while (i < len) {
			const lt = src.indexOf('<', i)
			if (lt < 0) {
				const txt = src.slice(i)
				if (txt) stack.at(-1).parts.push(unescapeXml(txt))
				break
			}
			if (lt > i) stack.at(-1).parts.push(unescapeXml(src.slice(i, lt)))
			if (src.startsWith('<!--', lt)) {
				const end = src.indexOf('-->', lt + 4)
				i = end < 0 ? len : end + 3
				continue
			}
			if (src.startsWith('<![CDATA[', lt)) {
				const end = src.indexOf(']]>', lt + 9)
				if (end < 0) break
				stack.at(-1).parts.push(src.slice(lt + 9, end))
				i = end + 3
				continue
			}
			if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
				const end = src.indexOf('>', lt + 2)
				i = end < 0 ? len : end + 1
				continue
			}
			if (src[lt + 1] === '/') {
				const end = src.indexOf('>', lt + 2)
				if (stack.length > 1) stack.pop()
				i = end < 0 ? len : end + 1
				continue
			}
			let gt = lt + 1
			let quote = ''
			while (gt < len) {
				const ch = src[gt]
				if (quote) {
					if (ch === quote) quote = ''
				} else if (ch === '"' || ch === "'") {
					quote = ch
				} else if (ch === '>') {
					break
				}
				gt++
			}
			const rawTag = src.slice(lt + 1, gt)
			const selfClosing = rawTag.endsWith('/')
			const body = (selfClosing ? rawTag.slice(0, -1) : rawTag).trim()
			const sp = body.search(/[\s]/)
			const tagName = sp < 0 ? body : body.slice(0, sp)
			const attrStr = sp < 0 ? '' : body.slice(sp + 1)
			const attrs = {}
			const nsMap = {...stack.at(-1).nsMap}
			for (const m of attrStr.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
				const val = unescapeXml(m[2] ?? m[3] ?? '')
				attrs[m[1]] = val
				if (m[1].startsWith('xmlns:')) nsMap[m[1].slice(6)] = val
			}
			const el = new XmlElement(tagName, attrs, nsMap, stack.at(-1))
			stack.at(-1).children.push(el)
			stack.at(-1).parts.push(el)
			if (!selfClosing) stack.push(el)
			i = gt + 1
		}
		return new XmlDocument(rootHolder.children[0] ?? null)
	}
}

let prevDOMParser
before(() => {
	prevDOMParser = globalThis.DOMParser
	globalThis.DOMParser = SimpleDOMParser
})
after(() => {
	globalThis.DOMParser = prevDOMParser
})

async function makeXlsx({workbookXml, stylesXml, sharedStringsXml, sheetXml}) {
	const zip = new JSZip()
	zip.file(
		'xl/workbook.xml',
		workbookXml ??
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
				'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
	)
	zip.file(
		'xl/_rels/workbook.xml.rels',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
			'</Relationships>',
	)
	if (stylesXml) zip.file('xl/styles.xml', stylesXml)
	if (sharedStringsXml) zip.file('xl/sharedStrings.xml', sharedStringsXml)
	zip.file('xl/worksheets/sheet1.xml', sheetXml)
	const buf = await zip.generateAsync({type: 'arraybuffer'})
	return buf
}

test('readXlsx renders [h]:mm, [h]:mm:ss, [m]:ss, and [s] durations instead of 1899 dates', async () => {
	const buf = await makeXlsx({
		stylesXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
			'<numFmts count="5">' +
			'<numFmt numFmtId="164" formatCode="[h]:mm"/>' +
			'<numFmt numFmtId="165" formatCode="[h]:mm:ss"/>' +
			'<numFmt numFmtId="166" formatCode="[m]:ss"/>' +
			'<numFmt numFmtId="167" formatCode="[s]"/>' +
			'<numFmt numFmtId="168" formatCode="0&quot;[h]&quot;"/>' +
			'</numFmts>' +
			'<cellXfs count="6">' +
			'<xf numFmtId="164"/>' +
			'<xf numFmtId="46"/>' +
			'<xf numFmtId="165"/>' +
			'<xf numFmtId="166"/>' +
			'<xf numFmtId="167"/>' +
			'<xf numFmtId="168"/>' +
			'</cellXfs>' +
			'</styleSheet>',
		sheetXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1"><c r="A1" s="0"><v>0.5</v></c><c r="B1" s="0"><v>1.25</v></c><c r="C1" s="0"><v>1.5</v></c></row>' +
			'<row r="2"><c r="A2" s="1"><v>1.5</v></c><c r="B2" s="2"><v>1.5</v></c><c r="C2" s="0"><v>-0.5</v></c></row>' +
			'<row r="3"><c r="A3" s="3"><v>0.0625</v></c><c r="B3" s="4"><v>0.001</v></c><c r="C3" s="5"><v>42</v></c></row>' +
			'</sheetData></worksheet>',
	})
	const sheets = await readXlsx(buf)
	assert.deepEqual(sheets[0].rows, [
		['12:00', '30:00', '36:00'],
		['36:00:00', '36:00:00', '-12:00'],
		['90:00', '86', '42'],
	])
})

test('readXlsx honours workbookPr date1904 without shifting durations', async () => {
	const stylesXml =
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		'<numFmts count="1"><numFmt numFmtId="164" formatCode="[h]:mm"/></numFmts>' +
		'<cellXfs count="2"><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>' +
		'</styleSheet>'
	const sheetXml =
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
		'<row r="1"><c r="A1" s="0"><v>43831</v></c><c r="B1" s="1"><v>1.5</v></c></row>' +
		'</sheetData></worksheet>'
	const wbWith = (pr) =>
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
		pr +
		'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'

	const s1900 = await readXlsx(await makeXlsx({workbookXml: wbWith(''), stylesXml, sheetXml}))
	assert.deepEqual(s1900[0].rows, [['2020-01-01', '36:00']])

	const s1904a = await readXlsx(await makeXlsx({workbookXml: wbWith('<workbookPr date1904="1"/>'), stylesXml, sheetXml}))
	assert.deepEqual(s1904a[0].rows, [['2024-01-02', '36:00']])

	const s1904b = await readXlsx(await makeXlsx({workbookXml: wbWith('<workbookPr date1904="true"/>'), stylesXml, sheetXml}))
	assert.deepEqual(s1904b[0].rows, [['2024-01-02', '36:00']])

	const s1904Off = await readXlsx(await makeXlsx({workbookXml: wbWith('<workbookPr date1904="0"/>'), stylesXml, sheetXml}))
	assert.deepEqual(s1904Off[0].rows, [['2020-01-01', '36:00']])
})

test('readXlsx handles the 1900 leap-year serial quirk without shifting 1904 workbooks', async () => {
	const stylesXml =
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		'<cellXfs count="2"><xf numFmtId="14"/><xf numFmtId="22"/></cellXfs>' +
		'</styleSheet>'
	const s1900 = await readXlsx(
		await makeXlsx({
			stylesXml,
			sheetXml:
				'<?xml version="1.0" encoding="UTF-8"?>' +
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
				'<row r="1">' +
				'<c r="A1" s="0"><v>1</v></c>' +
				'<c r="B1" s="0"><v>59</v></c>' +
				'<c r="C1" s="0"><v>60</v></c>' +
				'<c r="D1" s="0"><v>61</v></c>' +
				'<c r="E1" s="1"><v>60.5</v></c>' +
				'</row></sheetData></worksheet>',
		}),
	)
	assert.deepEqual(s1900[0].rows, [['1900-01-01', '1900-02-28', '1900-02-29', '1900-03-01', '1900-02-29 12:00']])

	const s1904 = await readXlsx(
		await makeXlsx({
			workbookXml:
				'<?xml version="1.0" encoding="UTF-8"?>' +
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
				'<workbookPr date1904="1"/>' +
				'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
			stylesXml,
			sheetXml:
				'<?xml version="1.0" encoding="UTF-8"?>' +
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
				'<row r="1">' +
				'<c r="A1" s="0"><v>0</v></c>' +
				'<c r="B1" s="0"><v>1</v></c>' +
				'<c r="C1" s="0"><v>59</v></c>' +
				'<c r="D1" s="0"><v>60</v></c>' +
				'</row></sheetData></worksheet>',
		}),
	)
	assert.deepEqual(s1904[0].rows, [['1904-01-01', '1904-01-02', '1904-02-29', '1904-03-01']])
})

test('readXlsx and cleanNum keep plain and small numbers exact without float noise', async () => {
	const buf = await makeXlsx({
		sheetXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1">' +
			'<c r="A1"><v>398133.03</v></c>' +
			'<c r="B1"><v>1.5E-11</v></c>' +
			'<c r="C1"><v>0.30000000000000004</v></c>' +
			'<c r="D1"><v>7551937647.78</v></c>' +
			'</row></sheetData></worksheet>',
	})
	const sheets = await readXlsx(buf)
	assert.deepEqual(sheets[0].rows, [['398133.03', '1.5e-11', '0.3', '7551937647.78']])

	assert.equal(cleanNum('308191.09'), '308191.09')
	assert.equal(cleanNum('414562.59'), '414562.59')
	assert.equal(cleanNum('-0'), '0')
	assert.equal(cleanNum('1e-20'), '1e-20')
})

test('readXlsx preserves seconds and renders mm:ss as minutes and seconds', async () => {
	const buf = await makeXlsx({
		stylesXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
			'<numFmts count="4">' +
			'<numFmt numFmtId="164" formatCode="h:mm:ss"/>' +
			'<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/>' +
			'<numFmt numFmtId="166" formatCode="mm:ss"/>' +
			'<numFmt numFmtId="167" formatCode="h:mm AM/PM"/>' +
			'</numFmts>' +
			'<cellXfs count="8">' +
			'<xf numFmtId="164"/>' +
			'<xf numFmtId="165"/>' +
			'<xf numFmtId="166"/>' +
			'<xf numFmtId="19"/>' +
			'<xf numFmtId="21"/>' +
			'<xf numFmtId="45"/>' +
			'<xf numFmtId="47"/>' +
			'<xf numFmtId="167"/>' +
			'</cellXfs>' +
			'</styleSheet>',
		sheetXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1">' +
			'<c r="A1" s="0"><v>0.99999</v></c>' +
			'<c r="B1" s="1"><v>45000.99999</v></c>' +
			'<c r="C1" s="2"><v>0.0034722</v></c>' +
			'<c r="D1" s="3"><v>0.99999</v></c>' +
			'<c r="E1" s="4"><v>0.99999</v></c>' +
			'<c r="F1" s="5"><v>0.99999</v></c>' +
			'<c r="G1" s="6"><v>0.99999</v></c>' +
			'<c r="H1" s="5"><v>0.0034722</v></c>' +
			'<c r="I1" s="6"><v>0.0034722</v></c>' +
			'<c r="J1" s="7"><v>0.5</v></c>' +
			'</row></sheetData></worksheet>',
	})
	const sheets = await readXlsx(buf)
	assert.deepEqual(sheets[0].rows, [
		['23:59:59', '2023-03-15 23:59:59', '05:00', '23:59:59', '23:59:59', '59:59', '59:59', '05:00', '05:00', '12:00'],
	])
})

test('readXlsx formats built-in East Asian date and time numFmtIds 27-36 and 50-58', async () => {
	const ids = [14, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]
	const timeHmIds = new Set([32, 34, 55])
	const timeHmsIds = new Set([33, 35, 56])
	const xfs = ids.map((id) => `<xf numFmtId="${id}"/>`).join('')
	const cells45000 = ids.map((_, idx) => `<c s="${idx}"><v>45000</v></c>`).join('')
	const timeIdx = ids.flatMap((id, idx) => (timeHmIds.has(id) || timeHmsIds.has(id) ? [[id, idx]] : []))
	const cellsHalf = timeIdx.map(([, idx]) => `<c s="${idx}"><v>0.5</v></c>`).join('')

	const buf = await makeXlsx({
		stylesXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
			`<cellXfs count="${ids.length}">${xfs}</cellXfs>` +
			'</styleSheet>',
		sheetXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			`<row r="1">${cells45000}</row>` +
			`<row r="2">${cellsHalf}</row>` +
			'</sheetData></worksheet>',
	})
	const sheets = await readXlsx(buf)
	assert.deepEqual(
		sheets[0].rows[0],
		ids.map((id) => (timeHmsIds.has(id) ? '2023-03-15 00:00:00' : timeHmIds.has(id) ? '2023-03-15 00:00' : '2023-03-15')),
	)
	assert.deepEqual(
		sheets[0].rows[1],
		timeIdx.map(([id]) => (timeHmsIds.has(id) ? '12:00:00' : '12:00')),
	)
})

test('listZip keeps folder entries contiguous when folder names differ only by case', async () => {
	const zip = new JSZip()
	zip.file('a/b.txt', '1')
	zip.file('a/B.txt', '2')
	zip.file('A/d.txt', '3')
	zip.file('Docs/readme.md', '4')
	zip.file('docs/guide.md', '5')
	zip.file('foo-bar/a.txt', '6')
	zip.file('foo/z.txt', '7')
	const entries = await listZip(await zip.generateAsync({type: 'arraybuffer'}))
	const names = entries.map((e) => e.name)

	// Every descendant must appear inside its folder's contiguous block, before the next top-level folder
	const assertContiguous = (folder) => {
		const idx = names.indexOf(folder)
		assert.notEqual(idx, -1, `missing ${folder}`)
		let end = idx + 1
		while (end < names.length && names[end].startsWith(folder)) end++
		for (let k = end; k < names.length; k++) {
			assert.equal(names[k].startsWith(folder), false, `${names[k]} appeared outside ${folder}`)
		}
	}
	for (const d of ['a/', 'A/', 'Docs/', 'docs/', 'foo/', 'foo-bar/']) assertContiguous(d)
})

function makeRawStoredZip(items) {
	const locals = []
	const cds = []
	let offset = 0
	for (const {nameBytes, flags} of items) {
		const lh = Buffer.alloc(30 + nameBytes.length)
		lh.writeUInt32LE(0x04034b50, 0)
		lh.writeUInt16LE(20, 4)
		lh.writeUInt16LE(flags, 6)
		lh.writeUInt16LE(0x5421, 12)
		lh.writeUInt16LE(nameBytes.length, 26)
		Buffer.from(nameBytes).copy(lh, 30)
		locals.push(lh)

		const cd = Buffer.alloc(46 + nameBytes.length)
		cd.writeUInt32LE(0x02014b50, 0)
		cd.writeUInt16LE(20, 4)
		cd.writeUInt16LE(20, 6)
		cd.writeUInt16LE(flags, 8)
		cd.writeUInt16LE(0x5421, 14)
		cd.writeUInt16LE(nameBytes.length, 28)
		cd.writeUInt32LE(offset, 42)
		Buffer.from(nameBytes).copy(cd, 46)
		cds.push(cd)
		offset += lh.length
	}
	const cdBuf = Buffer.concat(cds)
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0)
	eocd.writeUInt16LE(items.length, 8)
	eocd.writeUInt16LE(items.length, 10)
	eocd.writeUInt32LE(cdBuf.length, 12)
	eocd.writeUInt32LE(offset, 16)
	const all = Buffer.concat([...locals, cdBuf, eocd])
	return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

test('listZip decodes CP437 filenames when UTF-8 flag is unset while preserving UTF-8 entries', async () => {
	assert.equal(decodeCp437(new Uint8Array([0x4b, 0x81, 0x63, 0x68, 0x65, 0x2e, 0x74, 0x78, 0x74])), 'Küche.txt')
	assert.equal(decodeCp437(new Uint8Array([0x9a, 0x62, 0x65, 0x72, 0x77, 0x65, 0x69, 0x73, 0x75, 0x6e, 0x67, 0x2e, 0x70, 0x64, 0x66])), 'Überweisung.pdf')
	assert.equal(decodeCp437(new Uint8Array([0x41, 0x80, 0xff])), 'AÇ\u00a0')

	const buf = makeRawStoredZip([
		{nameBytes: new Uint8Array([0x4b, 0x81, 0x63, 0x68, 0x65, 0x2e, 0x74, 0x78, 0x74]), flags: 0x0000},
		{nameBytes: new Uint8Array([0x9a, 0x62, 0x65, 0x72, 0x77, 0x65, 0x69, 0x73, 0x75, 0x6e, 0x67, 0x2e, 0x70, 0x64, 0x66]), flags: 0x0000},
		{nameBytes: new TextEncoder().encode('日本語/Küche.txt'), flags: 0x0800},
	])
	const entries = await listZip(buf)
	assert.deepEqual(
		entries.map((e) => e.name),
		['Küche.txt', 'Überweisung.pdf', '日本語/', '日本語/Küche.txt'],
	)
})

test('readXlsx ignores phonetic furigana <rPh> runs in shared strings and inline strings', async () => {
	const buf = await makeXlsx({
		sharedStringsXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">' +
			'<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>' +
			'<si><r><rPr><b/></rPr><t>東</t></r><r><t>京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>' +
			'</sst>',
		sheetXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1">' +
			'<c r="A1" t="s"><v>0</v></c>' +
			'<c r="B1" t="s"><v>1</v></c>' +
			'<c r="C1" t="inlineStr"><is><t>大阪</t><rPh sb="0" eb="2"><t>オオサカ</t></rPh><phoneticPr fontId="1"/></is></c>' +
			'</row></sheetData></worksheet>',
	})
	const sheets = await readXlsx(buf)
	assert.deepEqual(sheets[0].rows, [['東京', '東京', '大阪']])
})

test('readPptx recognises b="true" and i="true" as bold and italic', async () => {
	const zip = new JSZip()
	zip.file(
		'ppt/presentation.xml',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
			'<p:sldSz cx="12192000" cy="6858000"/>' +
			'<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
			'</p:presentation>',
	)
	zip.file(
		'ppt/_rels/presentation.xml.rels',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
			'</Relationships>',
	)
	zip.file(
		'ppt/slides/slide1.xml',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
			'<p:cSld><p:spTree><p:sp>' +
			'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></p:spPr>' +
			'<p:txBody><a:bodyPr/><a:p>' +
			'<a:r><a:rPr b="1" i="1"/><a:t>one</a:t></a:r>' +
			'<a:r><a:rPr b="true" i="true"/><a:t>two</a:t></a:r>' +
			'<a:r><a:rPr b="0" i="false"/><a:t>three</a:t></a:r>' +
			'<a:r><a:t>four</a:t></a:r>' +
			'</a:p></p:txBody>' +
			'</p:sp></p:spTree></p:cSld></p:sld>',
	)
	const deck = await readPptx(await zip.generateAsync({type: 'arraybuffer'}))
	const shape = deck.slides[0].shapes[0]
	assert.equal(shape.kind, 'text')
	assert.deepEqual(
		shape.paras[0].runs.map((r) => ({text: r.text, bold: r.bold, italic: r.italic})),
		[
			{text: 'one', bold: true, italic: true},
			{text: 'two', bold: true, italic: true},
			{text: 'three', bold: false, italic: false},
			{text: 'four', bold: false, italic: false},
		],
	)
})
