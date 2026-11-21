import type {FileEntry} from './api'

/** Check whether a file or folder name is non-empty and free of path separators or dots-only segments. */
export function isValidItemName(name: string): boolean {
	const trimmed = name.trim()
	return trimmed !== '' && !trimmed.includes('/') && trimmed !== '.' && trimmed !== '..'
}

/** Return true when the name prompt form can submit (only rename requires a changed name). */
export function canSubmitNamePrompt({
	name,
	initial,
	requireChange,
	busy,
}: {
	name: string
	initial: string
	requireChange?: boolean
	busy: boolean
}): boolean {
	if (busy || !isValidItemName(name)) return false
	if (requireChange && name.trim() === initial) return false
	return true
}

export type FavoriteItem = FileEntry | string

/** Extract the virtual path from either a FileEntry or a legacy favorite path string. */
export function favoritePath(item: FavoriteItem): string {
	return typeof item === 'string' ? item : item.path
}

/** Activate a file row only when Enter is pressed directly on the row, not a child action button. */
export function shouldActivateRowOnKey(e: {key: string; target: unknown; currentTarget: unknown}): boolean {
	return e.key === 'Enter' && e.target === e.currentTarget
}

/** Label for the share password row across idle, loading, loaded, and failed states. */
export function sharePasswordLabel({
	data,
	isFetching,
	error,
}: {
	data: string | undefined
	isFetching: boolean
	error: Error | null | undefined
}): string {
	if (data) return data
	if (isFetching) return '…'
	if (error) return `${error.message || 'Couldn’t load password'} · Tap to retry`
	return 'Tap to show'
}

/** Decide what tapping the share password row should do next. */
export function sharePasswordAction({
	data,
	reveal,
	isFetching,
}: {
	data: string | undefined
	reveal: boolean
	isFetching?: boolean
}): 'copy' | 'noop' | 'refetch' | 'reveal' {
	if (data) return 'copy'
	if (isFetching) return 'noop'
	return reveal ? 'refetch' : 'reveal'
}

/** Query keys invalidated once an upload batch finishes so both listings and Recents update. */
export const UPLOAD_REFRESH_KEYS = [['files.list'], ['files.recents']] as const

const COPY_SUFFIX_RE = / \(([2-9]|[1-9]\d+)\)$/

/** Remove a keep-both "(2)" suffix from a filename so collision copies still match originals. */
export function stripCopySuffix(name: string): string {
	if (COPY_SUFFIX_RE.test(name)) return name.replace(COPY_SUFFIX_RE, '')
	const dot = name.lastIndexOf('.')
	if (dot <= 0) return name
	return name.slice(0, dot).replace(COPY_SUFFIX_RE, '') + name.slice(dot)
}

/** Return picked photos whose name (or keep-both base name) and size are not already in Photos. */
export function filterUnsyncedPhotos<T extends {name: string; size: number}>(picked: T[], existing: FileEntry[]): T[] {
	const have = new Set<string>()
	for (const f of existing) {
		if (f.type === 'directory') continue
		have.add(`${f.name}:${f.size}`)
		have.add(`${stripCopySuffix(f.name)}:${f.size}`)
	}
	return picked.filter((f) => !have.has(`${f.name}:${f.size}`) && !have.has(`${stripCopySuffix(f.name)}:${f.size}`))
}

export type FileDragEventLike = {
	preventDefault: () => void
	dataTransfer: {types: readonly string[]; dropEffect: 'none' | 'copy' | 'link' | 'move'}
}

/** True when a drag event carries files from the OS. */
export function isFileDrag(e: FileDragEventLike): boolean {
	return e.dataTransfer.types.includes('Files')
}

/** Always prevent browser navigation for file drags; return true only when dropping can upload here. */
export function handleFileDragEnter(e: FileDragEventLike, canUpload: boolean): boolean {
	if (!isFileDrag(e)) return false
	e.preventDefault()
	return canUpload
}

/** Keep dropEffect visual feedback accurate and prevent default browser navigation for file drags. */
export function handleFileDragOver(e: FileDragEventLike, canUpload: boolean): boolean {
	if (!isFileDrag(e)) return false
	e.preventDefault()
	e.dataTransfer.dropEffect = canUpload ? 'copy' : 'none'
	return canUpload
}

/** Always swallow file drops on the Files screen; return true only when uploads are allowed here. */
export function handleFileDrop(e: FileDragEventLike, canUpload: boolean): boolean {
	if (!isFileDrag(e)) return false
	e.preventDefault()
	return canUpload
}

export type UploadFileItem = {file: File; rel?: string}
export type UploadBatch = {files: UploadFileItem[]; dirs: string[]}
export type DropEntryLike = {
	name: string
	isFile: boolean
	isDirectory: boolean
	file?: (ok: (file: File) => void, err: (e: unknown) => void) => void
	createReader?: () => {readEntries: (ok: (entries: DropEntryLike[]) => void, err: (e: unknown) => void) => void}
}
export type FileHandleLike = {
	kind: 'file'
	name: string
	getFile: () => Promise<File>
}
export type DirectoryHandleLike = {
	kind: 'directory'
	name: string
	values: () => AsyncIterable<FileHandleLike | DirectoryHandleLike>
}

/** Collect all unique relative directory paths (including empty folders), sorted shallowest first. */
export function collectUploadDirs(items: readonly UploadFileItem[], extraDirs: readonly string[] = []): string[] {
	const set = new Set<string>()
	const addAncestors = (dirPath: string) => {
		const parts = dirPath.split('/').filter(Boolean)
		for (let i = 0; i < parts.length; i++) set.add(parts.slice(0, i + 1).join('/'))
	}
	for (const it of items) {
		const parts = (it.rel ?? '').split('/').filter(Boolean)
		if (parts.length > 1) addAncestors(parts.slice(0, -1).join('/'))
	}
	for (const d of extraDirs) addAncestors(d)
	return [...set].sort((a, b) => a.split('/').length - b.split('/').length)
}

/** Walk dropped DataTransfer FileSystemEntry items, preserving empty subdirectories. */
export async function readDroppedEntries(entries: readonly DropEntryLike[]): Promise<UploadBatch> {
	const files: UploadFileItem[] = []
	const dirs: string[] = []
	const walk = async (entry: DropEntryLike, prefix: string): Promise<void> => {
		if (entry.isFile && entry.file) {
			const file = await new Promise<File>((res, rej) => entry.file!(res, rej))
			files.push({file, rel: prefix ? `${prefix}/${file.name}` : undefined})
		} else if (entry.isDirectory && entry.createReader) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name
			dirs.push(path)
			const reader = entry.createReader()
			for (;;) {
				const batch = await new Promise<DropEntryLike[]>((res, rej) => reader.readEntries(res, rej))
				if (!batch.length) break
				for (const child of batch) await walk(child, path)
			}
		}
	}
	for (const e of entries) await walk(e, '')
	return {files, dirs}
}

/** Call window.showDirectoryPicker as a method on win so Chromium does not throw Illegal invocation. */
export function pickDirectoryFromWindow(win: {showDirectoryPicker?: () => Promise<DirectoryHandleLike>}): Promise<DirectoryHandleLike> | null {
	return win.showDirectoryPicker ? win.showDirectoryPicker() : null
}

/** Walk a picked FileSystemDirectoryHandle tree, preserving empty subdirectories. */
export async function readDirectoryHandle(root: DirectoryHandleLike): Promise<UploadBatch> {
	const files: UploadFileItem[] = []
	const dirs: string[] = []
	const walk = async (dir: DirectoryHandleLike, prefix: string): Promise<void> => {
		dirs.push(prefix)
		for await (const child of dir.values()) {
			if (child.kind === 'file') {
				const file = await child.getFile()
				files.push({file, rel: `${prefix}/${file.name}`})
			} else if (child.kind === 'directory') {
				await walk(child, `${prefix}/${child.name}`)
			}
		}
	}
	await walk(root, root.name)
	return {files, dirs}
}

const EXT_KIND_LABELS: Record<string, string> = {
	doc: 'Word document',
	docx: 'Word document',
	xls: 'Excel spreadsheet',
	xlsx: 'Excel spreadsheet',
	ppt: 'PowerPoint presentation',
	pptx: 'PowerPoint presentation',
	pages: 'Pages document',
	numbers: 'Numbers spreadsheet',
	key: 'Keynote presentation',
	pdf: 'PDF document',
	md: 'Markdown document',
	markdown: 'Markdown document',
	txt: 'Text file',
	log: 'Text file',
	conf: 'Text file',
	ini: 'Text file',
	toml: 'Text file',
	csv: 'CSV spreadsheet',
	tsv: 'TSV spreadsheet',
	json: 'JSON file',
	xml: 'XML file',
	html: 'HTML document',
	htm: 'HTML document',
	css: 'CSS stylesheet',
	js: 'JavaScript file',
	mjs: 'JavaScript file',
	ts: 'TypeScript file',
	sh: 'Shell script',
	py: 'Python script',
	yml: 'YAML file',
	yaml: 'YAML file',
	iso: 'Disk image (ISO)',
	zip: 'ZIP archive',
	tar: 'TAR archive',
	gz: 'Gzip archive',
	tgz: 'TAR archive',
	'7z': '7Z archive',
	rar: 'RAR archive',
}

const MIME_KIND_LABELS: Record<string, string> = {
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
	'application/msword': 'Word document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
	'application/vnd.ms-excel': 'Excel spreadsheet',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation',
	'application/vnd.ms-powerpoint': 'PowerPoint presentation',
	'application/vnd.apple.pages': 'Pages document',
	'application/vnd.apple.numbers': 'Numbers spreadsheet',
	'application/vnd.apple.keynote': 'Keynote presentation',
	'application/pdf': 'PDF document',
	'application/x-iso9660-image': 'Disk image (ISO)',
	'text/markdown': 'Markdown document',
	'text/x-shellscript': 'Shell script',
	'text/plain': 'Text file',
}

const CATEGORY_SUFFIX: Array<[string, string]> = [
	['image/', 'image'],
	['video/', 'video'],
	['audio/', 'audio'],
	['font/', 'font'],
]

/** Return a plain-English kind label for the ItemSheet Kind row instead of raw MIME subtypes. */
export function fileKindLabel(f: Pick<FileEntry, 'name' | 'type'>): string {
	if (f.type === 'directory') return 'Folder'
	const dot = f.name.lastIndexOf('.')
	const e = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : ''
	if (e && EXT_KIND_LABELS[e]) return EXT_KIND_LABELS[e]
	if (MIME_KIND_LABELS[f.type]) return MIME_KIND_LABELS[f.type]
	for (const [prefix, noun] of CATEGORY_SUFFIX) {
		if (f.type.startsWith(prefix)) return e ? `${e.toUpperCase()} ${noun}` : `${noun[0].toUpperCase()}${noun.slice(1)}`
	}
	if (e) return `${e.toUpperCase()} file`
	if (f.type.startsWith('text/')) return 'Text file'
	return 'Unknown file'
}

export type {FileEntry}
