// Machine administration: the settings and history omarchyd keeps for each machine.
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type PortForward} from '../api'
import {useToast} from '../ui'

export type Drive = {
	id: string
	device: 'disk' | 'cdrom'
	bus: 'virtio' | 'sata' | 'scsi' | 'ide'
	target: string
	format: string
	role: 'seed' | 'answer' | null
	cache: string
	discard?: boolean
	sizeGb: number | null
	usedGb: number | null
	media: string | null
	inMachineFolder: boolean
}
export type Task = {id: string; type: string; detail?: string; status: 'running' | 'ok' | 'error'; startedAt: number; endedAt?: number; message?: string; machineId?: string; machineName?: string; vmid?: number}
export type Snapshot = {name: string; description: string; createdAt: number}
export type MachineDetails = {
	id: string
	vmid: number
	name: string
	osId?: string
	state: string
	pending: boolean
	createdAt?: number
	errorMessage?: string
	hardware: {sockets: number; cores: number; cpuType: string; memoryMb: number; firmware: 'bios' | 'efi'; machineType: 'q35' | 'pc'; video: string; nic: string; mac: string; linkDown: boolean; disks: Drive[]}
	boot: string[]
	options: {onBoot: boolean; startupOrder: number | null; startupDelay: number; protection: boolean; tablet: boolean; acpi: boolean; kvm: boolean; agent: boolean; bootMenu: boolean; notes: string}
	cloudInit: {username: string; hostname: string; sshKeys: string[]} | null
	portForwards: PortForward[]
	snapshots: Snapshot[]
	tasks: Task[]
	guestIps: string[]
}
export type NodeInfo = {
	hostname: string
	cpuModel: string
	threads: number
	loadAverage: number[]
	memoryTotalMb: number
	memoryFreeMb: number
	uptimeSeconds: number
	storage: {totalGb: number; freeGb: number} | null
	libvirtVersion: string | null
	qemuVersion: string | null
	kvmAvailable: boolean
	libvirtAvailable: boolean
	performanceWarning?: string
	videoModels: string[]
	cpuTypes: string[]
	nicModels: string[]
	diskBuses: string[]
	diskCaches: string[]
	counts: {total: number; running: number}
}
export type StatPoint = {t: number; cpu: number; memMb: number; netIn: number; netOut: number; diskRead: number; diskWrite: number}
export type Stats = {memoryMb: number; vcpus: number; points: StatPoint[]}
export type Backup = {id: string; name: string; vmid: number; sourceId: string; createdAt: number; notes: string; live: boolean; sizeBytes: number; path: string}

export const useMachineDetails = (id: string | null) =>
	useQuery({queryKey: ['machines.details', id], queryFn: () => query<MachineDetails>('machines.details', {id}), enabled: !!id, refetchInterval: 5000})
export const useNode = () => useQuery({queryKey: ['machines.node'], queryFn: () => query<NodeInfo>('machines.node'), refetchInterval: 15_000, staleTime: 10_000})
export const useStats = (id: string | null, enabled = true) =>
	useQuery({queryKey: ['machines.stats', id], queryFn: () => query<Stats>('machines.stats', {id}), enabled: !!id && enabled, refetchInterval: 10_000})
export const useBackups = (id?: string | null) => useQuery({queryKey: ['machines.backups', id ?? 'all'], queryFn: () => query<Backup[]>('machines.backups', id ? {id} : {}), refetchInterval: 15_000})
export const useAllTasks = () => useQuery({queryKey: ['machines.tasks'], queryFn: () => query<Task[]>('machines.tasks'), refetchInterval: 5000})

// Run a machine action; refresh everything that could have changed; toast the outcome.
export function useMachineAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input?: unknown; done?: string}) => mutate<unknown>(a.path, a.input),
		onSuccess: (_, a) => {
			if (a.done) toast(a.done)
		},
		onError: (error: Error) => toast(error.message, true),
		onSettled: () => {
			for (const k of ['machines.list', 'machines.details', 'machines.tasks', 'machines.backups', 'machines.node']) qc.invalidateQueries({queryKey: [k]})
		},
	})
}

export const TASK_LABEL: Record<string, string> = {
	create: 'Create',
	start: 'Start',
	shutdown: 'Shutdown',
	stop: 'Stop',
	reboot: 'Reboot',
	pause: 'Pause',
	resume: 'Resume',
	hibernate: 'Hibernate',
	hardware: 'Hardware',
	options: 'Options',
	boot: 'Boot order',
	'add-disk': 'Add disk',
	'edit-disk': 'Edit disk',
	'resize-disk': 'Resize disk',
	'remove-drive': 'Remove drive',
	'add-cdrom': 'Add CD/DVD drive',
	'insert-media': 'Insert media',
	'eject-media': 'Eject media',
	'cloud-init': 'Cloud-init',
	snapshot: 'Snapshot',
	rollback: 'Rollback',
	'delete-snapshot': 'Delete snapshot',
	backup: 'Backup',
	clone: 'Clone',
	restore: 'Restore',
}
export const CPU_LABEL: Record<string, string> = {host: 'host (fastest; this server’s own CPU)', 'host-model': 'host-model (migratable copy of this CPU)', max: 'max (every feature QEMU can offer)', qemu64: 'qemu64 (most compatible)'}
export const VIDEO_LABEL: Record<string, string> = {vga: 'Standard VGA', bochs: 'Bochs', virtio: 'VirtIO-GPU', qxl: 'SPICE (qxl)', cirrus: 'Cirrus', none: 'None'}
export const NIC_LABEL: Record<string, string> = {virtio: 'VirtIO (paravirtualized)', e1000e: 'Intel E1000E', e1000: 'Intel E1000', rtl8139: 'Realtek RTL8139'}
export const BUS_LABEL: Record<string, string> = {virtio: 'VirtIO Block', sata: 'SATA', scsi: 'SCSI (VirtIO SCSI)', ide: 'IDE'}
export const CACHE_LABEL: Record<string, string> = {default: 'Default (no cache)', none: 'No cache', writeback: 'Write back', writethrough: 'Write through', directsync: 'Direct sync', unsafe: 'Write back (unsafe)'}

export const mib = (mb: number) => (mb >= 1024 ? `${Math.round((mb / 1024) * 100) / 100} GiB` : `${mb} MiB`)
export const rate = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : bps >= 1e3 ? `${(bps / 1e3).toFixed(1)} kB/s` : `${Math.round(bps)} B/s`)
export const when = (t?: number) => (t ? new Date(t).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '–')
export const driveName = (d: Drive) => (d.role === 'seed' ? 'Cloud-init drive' : d.role === 'answer' ? 'Windows answer file' : d.device === 'cdrom' ? `CD/DVD drive (${d.target})` : `Hard disk (${d.target})`)
