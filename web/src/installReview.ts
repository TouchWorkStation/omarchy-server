import type {InstallReview} from './api'

export type ReviewInstallInput = {
	grant?: string[]
	folders?: {appId: string; id: string; path: string}[]
	folderAccess?: {id: string; sourcePath: string}[]
}

type Placed = Record<string, string | null | undefined>

export const folderKey = (f: {appId: string; id: string}) => `${f.appId}/${f.id}`

// A blank choice means "inside the app". A typed path has to stay strictly inside home,
// with no empty segments (//) and no hidden or dot segments (., .., .ssh).
export function folderPathOk(path: string | null | undefined, home: string) {
	if (path == null) return true
	const cleanHome = home.replace(/\/+$/, '')
	if (!cleanHome) return false
	const trimmed = path.trim().replace(/\/+$/, '')
	if (!trimmed.startsWith(`${cleanHome}/`) || trimmed.includes('\0')) return false
	const rel = trimmed.slice(cleanHome.length + 1)
	if (!rel) return false
	return rel.split('/').every((part) => part.length > 0 && !part.startsWith('.'))
}

// The green "nothing extra" review can install straight from Approve. Anything the person has to
// allow, place, or set up first uses the store's Before you install sheet.
export function installNeedsReview(review: InstallReview | null | undefined) {
	if (!review) return false
	return Boolean(review.permissions?.length || review.setup?.length || review.folders?.length || review.requiredFolders?.length || review.gpuAccess)
}

export function reviewInstallInput(review: InstallReview, allowed: boolean, placed: Placed): ReviewInstallInput | null {
	const access = review.permissions ?? []
	if (access.some((p) => p.id === 'refused')) return null
	if ((review.setup?.length ?? 0) > 0) return null
	if (access.length > 0 && !allowed) return null
	const home = review.home ?? ''
	const folders = review.folders ?? []
	if (!folders.every((f) => folderPathOk(placed[folderKey(f)], home) && placed[folderKey(f)] !== '')) return null
	const grant = [...new Set(access.map((p) => p.id))]
	const chosen = folders.filter((f) => placed[folderKey(f)]).map((f) => ({appId: f.appId, id: f.id, path: placed[folderKey(f)]!.trim()}))
	const folderAccess = (review.requiredFolders ?? []).map((f) => ({id: f.id, sourcePath: f.defaultSourcePath}))
	return {
		...(folderAccess.length ? {folderAccess} : {}),
		...(grant.length ? {grant} : {}),
		...(chosen.length ? {folders: chosen} : {}),
	}
}
