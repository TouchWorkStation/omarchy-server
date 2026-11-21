// Talks only to the Omarchy Server server (same origin). Shapes mirror omarchyd.

export const DEFAULT_TIMEOUT_MS = 20_000
export const SLOW_TIMEOUT_MS = 10 * 60_000
export type RequestOptions = {timeoutMs?: number; signal?: AbortSignal}

// Long blocking server operations keep a generous timeout; normal RPCs and polling fail in 20 s.
const SLOW_RPC = new Set([
	'unraid.connect',
	'unraid.scan',
	'backups.configure',
	'backups.shares',
	'backups.restoreApp',
	'backups.connectExisting',
	'backups.snapshots',
	'backups.computerSnapshots',
	'backups.setComputer',
	'backups.computerFolders',
	'storage.growSystem',
	'system.replaceCertificate',
	'system.desktopSignIn',
	'system.desktopShare',
	'omarchy.removeTheme',
	'storage.createPool',
	'storage.addToPool',
	'storage.importPool',
	'storage.forgetPool',
	'storage.unmount',
	'storage.mount',
	'storage.format',
	'swarm.storage.unmount',
	'swarm.storage.mount',
	'swarm.storage.format',
	'swarm.storage.createPool',
	'swarm.storage.addToPool',
	'swarm.storage.importPool',
	'swarm.storage.forgetPool',
	'swarm.storage.scrub',
	'files.copy',
	'files.unarchive',
	'files.move',
	'files.delete',
	'files.emptyTrash',
	'appStore.addRepository',
	'appStore.refresh',
	'omarchy.installPlugin',
	'swarm.action',
	'system.update',
	'machines.uninstall',
	'machines.snapshot',
	'machines.revertSnapshot',
	'machines.deleteSnapshot',
	'machines.resizeDisk',
	'machines.addDisk',
	'machines.restart',
	'machines.backup',
	'machines.restoreBackup',
	'machines.clone',
	'wifi.connect',
	'hardware.raid.addDevice',
	'hardware.raid.addMirror',
	'hardware.raid.addAccelerator',
	'hardware.raid.replaceDevice',
	'hardware.raid.transitionToFailsafeRaidz',
	'hardware.raid.scrub',
])

const RESTARTING_MESSAGE = 'Omarchy Server is restarting or not answering. Wait a moment and try again.'
const FRIENDLY_ERROR: Record<string, string> = {
	UNREACHABLE: RESTARTING_MESSAGE,
	BAD_RESPONSE: RESTARTING_MESSAGE,
	NOT_CONFIGURED: RESTARTING_MESSAGE,
}

export class ApiError extends Error {
	code: string
	status: number
	constructor(message: string, code: string, status: number) {
		super(message)
		this.code = code
		this.status = status
	}
}

function makeTimeoutSignal(timeoutMs: number, external?: AbortSignal) {
	// A ref'd timer, cleared when the request ends. AbortSignal.timeout() does not keep the
	// event loop alive, so a test (and a quiet tab) never saw the timeout fire.
	const controller = new AbortController()
	let expired = false
	const timer = setTimeout(() => {
		expired = true
		controller.abort(typeof DOMException === 'function' ? new DOMException('The operation was aborted due to timeout', 'TimeoutError') : undefined)
	}, timeoutMs)
	const onExternalAbort = () => controller.abort()
	if (external) {
		if (external.aborted) controller.abort()
		else external.addEventListener('abort', onExternalAbort, {once: true})
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer)
			external?.removeEventListener('abort', onExternalAbort)
		},
		timedOut: () => expired,
	}
}

async function handle<T>(res: Response, signal?: AbortSignal): Promise<T> {
	const body: unknown = await res.json().catch((err) => {
		if (signal?.aborted) throw err
		return null
	})
	const hasError = body !== null && typeof body === 'object' && !Array.isArray(body) && 'error' in body && Boolean((body as {error?: unknown}).error)
	if (!res.ok || hasError) {
		const err = hasError ? (body as {error: {message?: string; code?: string}}).error : {}
		const code = err.code ?? (!hasError && (res.status === 502 || res.status === 503 || res.status === 504) ? 'UNREACHABLE' : 'ERROR')
		let message = err.message ?? `Request failed (${res.status})`
		if (Object.hasOwn(FRIENDLY_ERROR, code)) {
			if (err.message && err.message !== FRIENDLY_ERROR[code] && typeof console !== 'undefined') {
				console.warn('[omarchy-server]', code, err.message)
			}
			message = FRIENDLY_ERROR[code]
		}
		const error = new ApiError(message, code, res.status)
		// A mistyped password or authenticator code is also 401. Leave the person on the form.
		const credentialMiss =
			err.message === 'Incorrect password' ||
			err.message === 'Invalid password' ||
			err.message === 'Incorrect 2FA code' ||
			err.message === 'Enter the 6-digit code from your authenticator app (2FA)' ||
			err.message === 'That 2FA code isn’t right. Try the current one.' ||
			err.message === 'That 2FA code was already used. Wait for the next one.'
		if (res.status === 401 && err.code === 'UNAUTHORIZED' && !credentialMiss && typeof window !== 'undefined') window.dispatchEvent(new Event('touch:signed-out'))
		throw error
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new ApiError(`Omarchy Server sent an answer this page can’t read (${res.status})`, 'INVALID_RESPONSE', res.status)
	}
	return body as T
}

async function request<T>(input: string, init: RequestInit, options?: RequestOptions, defaultTimeout = DEFAULT_TIMEOUT_MS): Promise<T> {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		throw new ApiError('You’re offline. Check your connection and try again.', 'OFFLINE', 0)
	}
	const {signal, cleanup, timedOut} = makeTimeoutSignal(options?.timeoutMs ?? defaultTimeout, options?.signal)
	try {
		const res = await fetch(input, {...init, signal})
		return await handle<T>(res, signal)
	} catch (error) {
		if (error instanceof ApiError) throw error
		if (timedOut() || (error instanceof Error && error.name === 'TimeoutError')) {
			throw new ApiError('The server took too long to answer. Check your connection and try again.', 'TIMEOUT', 0)
		}
		if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
			throw new ApiError('The request was interrupted before the server answered.', 'ABORTED', 0)
		}
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			throw new ApiError('You’re offline. Check your connection and try again.', 'OFFLINE', 0)
		}
		throw new ApiError('Can’t reach Omarchy Server. Check your connection and try again.', 'NETWORK', 0)
	} finally {
		cleanup()
	}
}

export const post = <T>(path: string, body?: unknown, options?: RequestOptions, defaultTimeout = DEFAULT_TIMEOUT_MS) =>
	request<T>(
		path,
		{
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
			body: JSON.stringify(body ?? {}),
			credentials: 'same-origin',
		},
		options,
		defaultTimeout,
	)

export async function query<T>(path: string, input?: unknown, options?: RequestOptions): Promise<T> {
	const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`
	const body = await request<{data: T}>(`/api/rpc/${path}${qs}`, {credentials: 'same-origin'}, options, SLOW_RPC.has(path) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
	return body.data
}

export async function mutate<T = unknown>(path: string, input?: unknown, options?: RequestOptions): Promise<T> {
	const body = await post<{data: T}>(`/api/rpc/${path}`, {input}, options, SLOW_RPC.has(path) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
	return body.data
}

export type Bootstrap = {
	touch: {version: string}
	configured: boolean
	server: null | {
		url: string
		host: string
		local?: boolean
		reachable: boolean
		version?: string
		name?: string
		startedAt?: number
		revision?: string
		device?: string | null
		onboarded?: boolean
		// How a browser tab reaches an app from this page (see server/app.mjs appAccess).
		appAccess?: 'relay' | 'direct' | 'none'
		error?: string
	}
	accounts: {userId: string; name: string; avatar: string | null; wallpaper: Wallpaper | null}[]
	session: null | {accountId: string; mode: 'native' | 'legacy'}
}

export const getBootstrap = (options?: RequestOptions) => request<Bootstrap>('/api/bootstrap', {credentials: 'same-origin'}, options, DEFAULT_TIMEOUT_MS)
export const setup = (url: string) => post<{ok: true; url: string; version: string}>('/api/setup', {url})
export const login = (body: {username: string; password: string; totpToken?: string}, options?: RequestOptions) =>
	post<{ok: true; accountId: string}>('/api/auth/login', body, options)
export const logout = () => post('/api/auth/logout')

// ---- omarchyd shapes ---------------------------------------------------------

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
	/** Apps that hold their own port: where Omarchy Server shows them inside its page. */
	viewPort?: number
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
	/** LAN port of a published job API. The token is credentials.defaultPassword. */
	apiPort?: number
	credentials?: {defaultUsername?: string; defaultPassword?: string; showBeforeOpen?: boolean; label?: string}
	dependencies?: string[]
	error?: string
	/** Runs on the server itself (Tailscale), not in a container: no container terminal. */
	system?: boolean
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
	/** True until the first measurement of apps, machines and files is done. */
	measuring?: boolean
	/** The drive the system is on. notInUse: space the drive has that the filesystem doesn't use yet. */
	drive?: {name: string; size: number; notInUse: number; steps: ('partition' | 'partition-not-last' | 'encryption' | 'filesystem')[]; partition: string | null; partitionNumber: number | null; encrypted: string | null; filesystem: string | null} | null
}
export type Temperature = {temperature: number | null; warning: string; reason?: 'virtual' | 'no-sensor'}
export type GpuInfo = {
	id: string
	index: number
	name: string
	used: number | null
	memoryUsed: number | null
	memoryTotal: number | null
	temperature: number | null
}
export type GpuUsage = {gpus: GpuInfo[]}
export type BatteryStatus = 'charging' | 'discharging' | 'full' | 'not-charging' | 'unknown'
export type BatteryInfo = {
	id: string
	index: number
	name: string
	percent: number | null
	status: BatteryStatus
	secondsRemaining: number | null
	power: number | null
	energyNow: number | null
	energyFull: number | null
}
export type BatteryUsage = {batteries: BatteryInfo[]}
export type SystemStats = {
	cpu: CpuUsage
	memory: MemoryUsage
	disk: DiskUsage
	temp: Temperature
	gpu: GpuUsage
	battery: BatteryUsage
	uptime: number
}
/** Share of the space you can use that's in use (like df: space kept back for the system isn't counted). */
export const diskPct = (d: DiskUsage) => (d.totalUsed + d.available > 0 ? (100 * d.totalUsed) / (d.totalUsed + d.available) : 0)

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
	/** Count of screenshots; set on the compact registry list in place of `gallery` URLs. */
	shots?: number
	unsupported?: string
	dependencies?: string[]
	/** Every app installed along with it, in install order (what it needs comes first). */
	needs?: string[]
	/** Apps it can stand in for (e.g. Bitcoin Knots for Bitcoin Node). */
	implements?: string[]
	/** It installs, but some optional features need something else. */
	caution?: string
	releaseNotes?: string
	installSize?: number
}
export type Registry = {meta: {id: string; name: string}; apps: RegistryApp[]}[]

export type PortForward = {id: string; protocol: 'tcp' | 'udp'; hostPort: number; guestPort: number}

export type Machine = {
	id: string
	vmid?: number
	name: string
	osId?: string
	cores?: number
	memoryGb?: number
	memoryMb?: number
	diskSizeGb?: number
	ipAddress?: string
	state: 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'suspended' | 'hibernated' | 'error'
	pending?: boolean
	protected?: boolean
	onBoot?: boolean
	installProgress?: number
	errorMessage?: string
	networkMode?: 'nat' | 'bridged'
	portForwards?: PortForward[]
}

// This server's own Omarchy desktop, shown in the same viewer as a machine's screen.
export const SERVER_DESKTOP: Machine = {id: 'desktop', name: 'Omarchy desktop', state: 'running'}

export type InstallReview = {
	requiredFolders: {id: string; name: string; note: string | null; defaultSourcePath: string; readOnly: boolean}[]
	gpuAccess: boolean
	/** Apps it needs that aren't installed yet: installed first, together with it. */
	alsoInstalls?: {id: string; name: string; icon?: string}[]
	/** Extra access the apps ask for; each must be allowed explicitly. */
	permissions?: {id: string; label: string; detail: string; what: string[]; appId: string; appName: string}[]
	/** Apps installed on the server itself that need a one-time command from you first. */
	setup?: {appId: string; appName: string; command: string}[]
	/** Folders you choose a place for: inside the app, or a folder of yours (suggested under your home). */
	folders?: {appId: string; appName: string; id: string; label: string; detail: string; suggest: string | null}[]
	home?: string
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

export type AssistantProvider = 'spacexai' | 'openai' | 'anthropic' | 'openai-compatible' | 'chatgpt'
// Which endpoint the assistant streams from: /chat/completions or /responses.
export type AssistantApi = 'chat' | 'responses'
// How hard a reasoning model thinks; '' leaves the model's default.
export type AssistantEffort = '' | 'low' | 'medium' | 'high'
export type AssistantCheck = {ok: boolean; status: string; message: string; at: number}
export type AssistantModel = {id: string; name?: string}
// A live check: the stored check plus the models the endpoint serves.
export type AssistantVerify = AssistantCheck & {modelFound: boolean | null; models: AssistantModel[]}
export type AssistantKey = {
	id: string
	name: string
	provider: AssistantProvider
	baseUrl: string
	model: string
	api: AssistantApi
	effort: AssistantEffort
	check: AssistantCheck | null
	last4: string
	ownerUserId: string
	sharedWith: string[]
	systemDefault: boolean
	mine: boolean
	// Sign in with ChatGPT: the account, and whether the sign-in still has a refresh token.
	account?: string | null
	signedIn?: boolean
}

// Public card. The chat shows these fields only — never rpc input, passwords, apiKey, or credentials.
export type AssistantAction = {
	id: string
	status: 'pending' | 'rejected' | 'running' | 'done' | 'error'
	kind: 'rpc' | 'mcp'
	toolName: string
	title: string
	detail: string
	// Present on an install card so Approve can open the store review. Never a grant.
	appId?: string
	error?: string
	picker?: {theme: string | null; selected: string | null}
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
export type SmbShare = {name: string; path: string; available: boolean; sharename: string; password: boolean; readOnly: boolean}

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
export type UsbBound = {kind: 'machine' | 'app'; id: string; name: string}
export type UsbDevice = {
	id: string
	name: string
	vendorId: string
	productId: string
	serial: string | null
	path: string | null
	node: string | null
	bound: UsbBound | null
	needsRestart: boolean
}
export type UsbList = {devices: UsbDevice[]}
