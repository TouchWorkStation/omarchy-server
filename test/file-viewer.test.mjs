import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import {Marked} from 'marked'

import {
	ZIP_ENTRY_LIMIT,
	classifyLinkHref,
	handleDocumentLinkClick,
	headingSlug,
	renderMarkdownHtml,
	shouldIgnoreViewerKey,
	zipTruncatedNote,
} from '../web/src/screens/viewer/helpers.ts'

test('headingSlug generates GitHub-style slugs and deduplicates repeats', () => {
	const seen = new Map()
	assert.equal(headingSlug('Intro', seen), 'intro')
	assert.equal(headingSlug('Getting Started!', seen), 'getting-started')
	assert.equal(headingSlug('A &amp; B', seen), 'a--b')
	assert.equal(headingSlug('Notes', seen), 'notes')
	assert.equal(headingSlug('Notes', seen), 'notes-1')
	assert.equal(headingSlug('Notes', seen), 'notes-2')
	assert.equal(headingSlug('Notes 1', seen), 'notes-1-1')
	assert.equal(headingSlug('<code>foo</code> &amp; <em>bar</em>', seen), 'foo--bar')
	assert.equal(headingSlug('!!!', seen), '')
})

test('renderMarkdownHtml adds id and data-heading-id attributes to headings', async () => {
	const html = await renderMarkdownHtml('# Intro\n\n## Getting Started!\n\n## Intro\n\n## Title\n', Marked)
	assert.match(html, /<h1 id="intro" data-heading-id="intro">Intro<\/h1>/)
	assert.match(html, /<h2 id="getting-started" data-heading-id="getting-started">Getting Started!<\/h2>/)
	assert.match(html, /<h2 id="intro-1" data-heading-id="intro-1">Intro<\/h2>/)
	assert.match(html, /<h2 id="title" data-heading-id="title">Title<\/h2>/)
})

test('classifyLinkHref distinguishes anchors, external http(s) URLs, mailto, and relative/unsafe links', () => {
	assert.deepEqual(classifyLinkHref('#intro'), {kind: 'anchor', id: 'intro'})
	assert.deepEqual(classifyLinkHref('#caf%C3%A9'), {kind: 'anchor', id: 'café'})
	assert.deepEqual(classifyLinkHref('#'), {kind: 'anchor', id: ''})
	assert.deepEqual(classifyLinkHref('https://example.com/a?b=1'), {kind: 'external', url: 'https://example.com/a?b=1'})
	assert.deepEqual(classifyLinkHref('HTTP://example.com'), {kind: 'external', url: 'HTTP://example.com'})
	assert.deepEqual(classifyLinkHref('mailto:a@b.c'), {kind: 'mailto'})
	assert.deepEqual(classifyLinkHref('MAILTO:a@b.c?subject=hi'), {kind: 'mailto'})
	assert.deepEqual(classifyLinkHref('docs/a.md'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref('./a.md'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref('../a.md'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref('/abs/path'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref('//evil.example/x'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref('javascript:alert(1)'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref('https:relative'), {kind: 'ignore'})
	assert.deepEqual(classifyLinkHref(null), {kind: 'ignore'})
})

const makeAnchorEvent = (rawHref, targets = []) => {
	let prevented = false
	const anchor = {
		tagName: 'A',
		getAttribute(name) {
			return name === 'href' ? rawHref : null
		},
		closest(sel) {
			return sel === 'a' ? this : null
		},
	}
	const event = {
		target: anchor,
		currentTarget: {
			querySelectorAll() {
				return targets
			},
		},
		preventDefault() {
			prevented = true
		},
	}
	return {event, isPrevented: () => prevented}
}

test('handleDocumentLinkClick handles anchors, external links, mailto, and relative links safely', () => {
	const scrolled = []
	const heading = {
		id: 'intro',
		getAttribute(name) {
			if (name === 'data-heading-id') return 'intro'
			return null
		},
		scrollIntoView(opts) {
			scrolled.push({el: 'intro', opts})
		},
	}
	const clobberedTitle = {
		id: '',
		getAttribute(name) {
			if (name === 'data-heading-id') return 'title'
			return null
		},
		scrollIntoView(opts) {
			scrolled.push({el: 'title', opts})
		},
	}

	const opened = []
	const openExternal = (url) => opened.push(url)

	const anchorClick = makeAnchorEvent('#intro', [heading, clobberedTitle])
	const a1 = handleDocumentLinkClick(anchorClick.event, openExternal)
	assert.deepEqual(a1, {kind: 'anchor', id: 'intro'})
	assert.equal(anchorClick.isPrevented(), true)
	assert.deepEqual(scrolled, [{el: 'intro', opts: {block: 'start'}}])
	assert.deepEqual(opened, [])

	// Falls back to data-heading-id when DOMPurify strips a clobbering id="title"
	const titleClick = makeAnchorEvent('#title', [heading, clobberedTitle])
	handleDocumentLinkClick(titleClick.event, openExternal)
	assert.equal(titleClick.isPrevented(), true)
	assert.deepEqual(scrolled.at(-1), {el: 'title', opts: {block: 'start'}})

	// Relative link: prevented and NOT opened in a new tab
	const relClick = makeAnchorEvent('docs/a.md', [heading])
	const a2 = handleDocumentLinkClick(relClick.event, openExternal)
	assert.deepEqual(a2, {kind: 'ignore'})
	assert.equal(relClick.isPrevented(), true)
	assert.deepEqual(opened, [])

	// External http(s) link: prevented and opened in a new tab
	const extClick = makeAnchorEvent('https://example.com/docs', [heading])
	const a3 = handleDocumentLinkClick(extClick.event, openExternal)
	assert.deepEqual(a3, {kind: 'external', url: 'https://example.com/docs'})
	assert.equal(extClick.isPrevented(), true)
	assert.deepEqual(opened, ['https://example.com/docs'])

	// mailto link: NOT prevented so browser handles it
	const mailClick = makeAnchorEvent('mailto:a@b.c', [heading])
	const a4 = handleDocumentLinkClick(mailClick.event, openExternal)
	assert.deepEqual(a4, {kind: 'mailto'})
	assert.equal(mailClick.isPrevented(), false)
	assert.deepEqual(opened, ['https://example.com/docs'])

	// Anchor tag without href (e.g. bookmark target): NOT prevented
	const noHrefClick = makeAnchorEvent(null, [heading])
	const a5 = handleDocumentLinkClick(noHrefClick.event, openExternal)
	assert.equal(a5, null)
	assert.equal(noHrefClick.isPrevented(), false)
})

test('FileViewer TextView uses renderMarkdownHtml and handleDocumentLinkClick', async () => {
	const src = await readFile(new URL('../web/src/screens/viewer/FileViewer.tsx', import.meta.url), 'utf8')
	assert.match(src, /renderMarkdownHtml/)
	assert.match(src, /fv-md[\s\S]{0,160}handleDocumentLinkClick/)
	assert.doesNotMatch(src, /if \(a\?\.href\)/)
})

test('DocxView handles mammoth internal bookmark links and external links safely', async () => {
	const zip = new JSZip()
	zip.file(
		'[Content_Types].xml',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
			'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
			'<Default Extension="xml" ContentType="application/xml"/>' +
			'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
			'</Types>',
	)
	zip.file(
		'_rels/.rels',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
			'</Relationships>',
	)
	zip.file(
		'word/_rels/document.xml.rels',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>' +
			'<Relationship Id="rIdMail" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:help@example.com" TargetMode="External"/>' +
			'</Relationships>',
	)
	zip.file(
		'word/document.xml',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
			'<w:body>' +
			'<w:p><w:hyperlink w:anchor="_Toc1"><w:r><w:t>Go to chapter</w:t></w:r></w:hyperlink></w:p>' +
			'<w:p><w:hyperlink r:id="rIdExt"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>' +
			'<w:p><w:hyperlink r:id="rIdMail"><w:r><w:t>email</w:t></w:r></w:hyperlink></w:p>' +
			'<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Chapter</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>' +
			'</w:body></w:document>',
	)
	const buffer = await zip.generateAsync({type: 'nodebuffer'})
	const {value: html} = await mammoth.convertToHtml({buffer})
	assert.match(html, /href="#_Toc1"/)
	assert.match(html, /id="_Toc1"/)
	assert.match(html, /href="https:\/\/example\.com\/"/)
	assert.match(html, /href="mailto:help@example\.com"/)

	const scrolled = []
	const bookmark = {
		id: '_Toc1',
		getAttribute: () => null,
		scrollIntoView: (opts) => scrolled.push(opts),
	}
	const opened = []
	const tocClick = makeAnchorEvent('#_Toc1', [bookmark])
	assert.deepEqual(handleDocumentLinkClick(tocClick.event, (u) => opened.push(u)), {kind: 'anchor', id: '_Toc1'})
	assert.equal(tocClick.isPrevented(), true)
	assert.deepEqual(scrolled, [{block: 'start'}])
	assert.deepEqual(opened, [])

	const extClick = makeAnchorEvent('https://example.com/', [bookmark])
	assert.deepEqual(handleDocumentLinkClick(extClick.event, (u) => opened.push(u)), {kind: 'external', url: 'https://example.com/'})
	assert.equal(extClick.isPrevented(), true)
	assert.deepEqual(opened, ['https://example.com/'])

	const mailClick = makeAnchorEvent('mailto:help@example.com', [bookmark])
	assert.deepEqual(handleDocumentLinkClick(mailClick.event, (u) => opened.push(u)), {kind: 'mailto'})
	assert.equal(mailClick.isPrevented(), false)

	const src = await readFile(new URL('../web/src/screens/viewer/FileViewer.tsx', import.meta.url), 'utf8')
	assert.match(src, /fv-paper[\s\S]{0,160}handleDocumentLinkClick/)
})

test('ZipView shows a note when a zip archive has more than 5,000 entries', async () => {
	assert.equal(ZIP_ENTRY_LIMIT, 5000)
	assert.equal(zipTruncatedNote(0), null)
	assert.equal(zipTruncatedNote(5000), null)
	assert.equal(zipTruncatedNote(6000), 'Showing the first 5,000 of 6,000 entries.')

	const src = await readFile(new URL('../web/src/screens/viewer/FileViewer.tsx', import.meta.url), 'utf8')
	assert.match(src, /entries\.slice\(0,\s*ZIP_ENTRY_LIMIT\)/)
	assert.match(src, /fv-note[\s\S]{0,80}zipTruncatedNote/)
})

test('PdfView and PptxView ignore keyboard navigation inside editable fields or open sheets', async () => {
	const fakeTarget = (matched) => ({
		closest(sel) {
			return matched && sel.includes(matched) ? this : null
		},
	})
	const noSheet = () => false
	const openSheet = () => true

	assert.equal(shouldIgnoreViewerKey(fakeTarget('input'), noSheet), true)
	assert.equal(shouldIgnoreViewerKey(fakeTarget('textarea'), noSheet), true)
	assert.equal(shouldIgnoreViewerKey(fakeTarget('select'), noSheet), true)
	assert.equal(shouldIgnoreViewerKey(fakeTarget('[contenteditable="true"]'), noSheet), true)
	assert.equal(shouldIgnoreViewerKey({isContentEditable: true}, noSheet), true)
	assert.equal(shouldIgnoreViewerKey(fakeTarget(null), openSheet), true)
	assert.equal(shouldIgnoreViewerKey(fakeTarget(null), noSheet), false)
	assert.equal(shouldIgnoreViewerKey(null, noSheet), false)
	assert.equal(shouldIgnoreViewerKey({}, noSheet), false)

	const src = await readFile(new URL('../web/src/screens/viewer/FileViewer.tsx', import.meta.url), 'utf8')
	assert.match(src, /function PdfView[\s\S]*?if \(!doc \|\| shouldIgnoreViewerKey\(e\.target\)\) return;/)
	assert.match(src, /function PptxView[\s\S]*?if \(!deck \|\| shouldIgnoreViewerKey\(e\.target\)\) return;/)
})
