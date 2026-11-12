// Talks only to the UmbrelOS Touch server (same origin). Shapes mirror umbreld 2.0.

export class ApiError extends Error {
	code: string
	status: number
	constructor(message: string, code: string, status: number) {
		super(message)
		this.code = code
		this.status = status
	}
}

async function handle<T>(res: Response): Promise<T> {
	const body = await res.json().catch(() => null)
	if (!res.ok || body?.error) {
		const err = body?.error ?? {}
		const error = new ApiError(err.message ?? `Request failed (${res.status})`, err.code ?? 'ERROR', res.status)
		if (res.status === 401 && err.code === 'UNAUTHORIZED') window.dispatchEvent(new Event('touch:signed-out'))
		throw error
	}
	return body as T
}

const post = <T>(path: string, body?: unknown) =>
	fetch(path, {
		method: 'POST',
		headers: {'content-type': 'application/json', 'x-umbrel-touch': '1'},
		body: JSON.stringify(body ?? {}),
		credentials: 'same-origin',
	}).then((r) => handle<T>(r))

export async function query<T>(path: string, input?: unknown): Promise<T> {
	const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`
	const body = await fetch(`/api/rpc/${path}${qs}`, {credentials: 'same-origin'}).then((r) => handle<{data: T}>(r))
	return body.data
}

export async function mutate<T = unknown>(path: string, input?: unknown): Promise<T> {
	const body = await post<{data: T}>(`/api/rpc/${path}`, {input})
	return body.data
}

export type Bootstrap = {
	touch: {version: string}
	configured: boolean
	umbrel: null | {
		url: string
		host: string
		reachable: boolean
		version?: string
		name?: string
		device?: string | null
		onboarded?: boolean
		error?: string
	}
	accounts: {userId: string; name: string; avatar: string | null; wallpaper: Wallpaper | null}[]
	session: null | {accountId: string; mode: 'native' | 'legacy'}
}

export const getBootstrap = () => fetch('/api/bootstrap', {credentials: 'same-origin'}).then((r) => handle<Bootstrap>(r))
export const setup = (url: string) => post<{ok: true; url: string; version: string}>('/api/setup', {url})
export const login = (body: {username: string; password: string; totpToken?: string}) =>
	post<{ok: true; accountId: string}>('/api/auth/login', body)
export const logout = () => post('/api/auth/logout')

// ---- umbreld shapes ---------------------------------------------------------

export type Wallpaper = {id: string; brandColorHsl: string | null}
export type User = {userId: string; name: string; role: 'owner' | 'member'; avatarUrl?: string; wallpaper?: Wallpaper; sambaUsername?: string}

export type AppState =
	| 'unknown'
	| 'installing'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'restarting'
	| 'uninstalling'
	| 'updating'
	| 'ready'
	| 'not-installed'

export type UserApp = {
	id: string
	name?: string
	version?: string
	icon?: string
	port?: number
	path?: string
	state?: AppState
	progress?: number
	requiresHttps?: boolean
	torOnly?: boolean
	credentials?: {defaultUsername?: string; defaultPassword?: string; showBeforeOpen?: boolean}
	dependencies?: string[]
	error?: string
}

export type UsageItem = {id: string; used: number; name?: string}
export type CpuUsage = {threads: number; totalUsed: number; system: number; apps: UsageItem[]; machines: UsageItem[]}
export type MemoryUsage = {size: number; totalUsed: number; system: number; apps: UsageItem[]; machines: UsageItem[]}
export type DiskUsage = {
	size: number
	totalUsed: number
	available: number
	system: number
	files?: number
	apps: UsageItem[]
	machines: UsageItem[]
}

export type RegistryApp = {
	id: string
	name: string
	tagline?: string
	icon?: string
	category?: string
	version?: string
	description?: string
	developer?: string
	website?: string
	gallery?: string[]
	dependencies?: string[]
	releaseNotes?: string
	installSize?: number
}
export type Registry = {meta: {id: string; name: string}; apps: RegistryApp[]}[]

export type Machine = {
	id: string
	name: string
	osId?: string
	cores?: number
	memoryGb?: number
	diskSizeGb?: number
	ipAddress?: string
	state: 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'suspended' | 'error'
	installProgress?: number
	errorMessage?: string
}

export type InstallReview = {
	requiredFolders: {id: string; name: string; note: string | null; defaultSourcePath: string; readOnly: boolean}[]
	gpuAccess: boolean
}

export type OsImage = {
	id: string
	familyId: string
	name: string
	variantName?: string
	version: string
	sizeMb: number
	arch: 'amd64' | 'arm64'
	platform?: 'linux' | 'windows'
	requiresCredentials: boolean
	custom?: boolean
	state: 'available' | 'downloading' | 'downloaded' | 'failed'
	downloadProgress?: number
	evaluation?: boolean
	manualSetup?: boolean
	requiresLicenseKey?: boolean
}
export type MachineCapabilities = {hostArchitecture: 'amd64' | 'arm64'; libvirtAvailable: boolean; kvmAvailable: boolean; performanceWarning?: string}
export type ActiveSession = {
	id: string
	createdAt: number
	lastSeenAt: number
	current: boolean
	client: {type: 'native'; id?: string; platform?: string; deviceClass?: string; appVersion?: string} | {type: 'browser'; userAgent?: string}
}

export type FileEntry = {
	name: string
	path: string
	type: string // 'directory' or a mime type
	size?: number
	modified: number
	operations: ('copy' | 'move' | 'rename' | 'trash' | 'restore' | 'delete' | 'favorite' | 'unarchive' | 'share' | 'writable')[]
	thumbnail?: string
}
export type Listing = FileEntry & {files: FileEntry[]; hasMore?: boolean; totalFiles?: number; truncatedAt?: number}
export type SmbShare = {name: string; path: string; available: boolean; sharename: string}

// ---- storage (hardware.internalStorage / hardware.raid) -------------------------------
export type StorageDevice = {
	type: 'ssd' | 'hdd'
	transport: 'nvme' | 'sata' | 'sas'
	device: string
	id?: string
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize?: number
	temperature?: number
	temperatureWarning?: number
	temperatureCritical?: number
	lifetimeUsed?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
	isSystemDrive?: boolean
}
export type PoolState = 'ONLINE' | 'DEGRADED' | 'FAULTED' | 'OFFLINE' | 'UNAVAIL' | 'REMOVED' | 'CANT_OPEN'
export type PoolMember = {id: string; status: PoolState; readErrors: number; writeErrors: number; checksumErrors: number}
type Progress<S extends string> = {state: S; progress: number}
export type RaidStatus = {
	name?: string
	exists: boolean
	raidType?: 'storage' | 'failsafe'
	topology?: 'stripe' | 'raidz' | 'mirror'
	status?: PoolState
	totalSpace?: number
	usableSpace?: number
	usedSpace?: number
	freeSpace?: number
	devices?: PoolMember[]
	mirrors?: string[][]
	dataErrors?: number
	accelerator?: {exists: boolean; l2arcSize?: number; specialSize?: number; devices?: PoolMember[]}
	expansion?: Progress<'expanding' | 'finished' | 'canceled'>
	rebuild?: Progress<'rebuilding' | 'finished' | 'canceled'>
	scrub?: Progress<'scrubbing' | 'finished' | 'canceled'> & {errors: number}
	replace?: Progress<'rebuilding' | 'expanding' | 'finished' | 'canceled'>
	failsafeTransitionStatus?: Progress<'syncing' | 'rebooting' | 'rebuilding' | 'complete' | 'error'> & {error?: string}
}
export type UsbDrive = {
	id: string
	name: string
	transport: string
	size: number
	partitions: {id: string; label?: string; size: number; mountpoints: string[]}[]
}
