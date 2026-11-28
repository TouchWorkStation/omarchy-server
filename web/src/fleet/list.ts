// One list for this server, joined computers, guests, and system containers (LXC).
// Online names come first, then offline names. A guest or container runs on a computer (this server, today).
// An ability that was not granted says why. Being offline is a separate fact: the grant stays.

export type FleetKind = 'server' | 'computer' | 'guest' | 'container'
export type FleetAbilityKey = 'apps' | 'vms' | 'files' | 'storage' | 'terminal' | 'desktop' | 'backups'

export type FleetAbility = {
	key: FleetAbilityKey
	granted: boolean
	reason: string
}

export type FleetMember = {
	id: string
	kind: FleetKind
	name: string
	online: boolean
	entrypoint: boolean
	/** The computer a guest runs on. Empty for the server and for joined computers. */
	hostId: string
	meta: string
	abilities: FleetAbility[]
}

export const SERVER_FLEET_ID = 'server'

const KEYS: FleetAbilityKey[] = ['apps', 'vms', 'files', 'storage', 'terminal', 'desktop', 'backups']

export type ComputerFleetInput = {
	id: string
	name: string
	online: boolean
	allowed?: Partial<Record<'terminal' | 'desktop' | 'storage' | 'backup' | 'files' | 'apps' | 'vms', boolean>>
	on?: Partial<Record<'terminal' | 'desktop' | 'storage' | 'backup' | 'files' | 'apps' | 'vms', boolean>>
	libvirt?: boolean
}

export type GuestFleetInput = {
	id: string
	name: string
	state: string
	hostId?: string
	connector?: boolean
}

export type ContainerFleetInput = {
	id: string
	name: string
	state: string
	hostId?: string
	hostName?: string
	connector?: boolean
}

export type ServerFleetInput = {
	name: string
	online?: boolean
	/** False when this server cannot create virtual machines. */
	vms?: boolean
}

const byName = (a: {name: string}, b: {name: string}) => a.name.localeCompare(b.name)

const grant = (key: FleetAbilityKey, ok: boolean, reason: string): FleetAbility => ({key, granted: ok, reason: ok ? '' : reason})

function pair(row: ComputerFleetInput, key: 'terminal' | 'desktop' | 'storage' | 'backup' | 'files' | 'apps' | 'vms') {
	return !!(row.allowed?.[key] && row.on?.[key])
}

function computerAbilities(row: ComputerFleetInput): FleetAbility[] {
	const name = row.name
	return [
		grant('apps', row.online, `${name} is offline, so it can’t take an install.`),
		grant('vms', !!(row.online && pair(row, 'vms') && row.libvirt), `${name} can’t host its own virtual machines.`),
		grant('files', pair(row, 'files'), `${name} hasn’t granted Files.`),
		grant('storage', pair(row, 'storage'), `${name} hasn’t granted Storage.`),
		grant('terminal', pair(row, 'terminal'), `${name} hasn’t granted Terminal.`),
		grant('desktop', pair(row, 'desktop'), `${name} hasn’t granted Desktop.`),
		grant('backups', pair(row, 'backup'), `${name} hasn’t granted Backups.`),
	]
}

function guestAbilities(row: GuestFleetInput): FleetAbility[] {
	const name = row.name
	const on = !!row.connector
	return [
		grant('apps', on && row.state === 'running', on ? `${name} is not running.` : `Install the connector on ${name} before apps can be installed there.`),
		grant('vms', false, `${name} can’t host its own virtual machines.`),
		grant('files', on, `Install the connector on ${name} before its files can be opened.`),
		grant('storage', false, `Storage stays on the computer that hosts ${name}.`),
		grant('terminal', on, `Install the connector on ${name} before a terminal can open there.`),
		grant('desktop', on, `Install the connector on ${name} before its desktop can be opened.`),
		grant('backups', false, `Backups from ${name} aren’t available yet.`),
	]
}

function containerStatusWord(state: string): string {
	if (state === 'running') return 'online'
	if (state === 'frozen') return 'paused'
	if (state === 'stopped' || !state) return 'offline'
	if (state === 'error') return 'error'
	return state.charAt(0).toUpperCase() + state.slice(1)
}

function containerAbilities(row: ContainerFleetInput): FleetAbility[] {
	const name = row.name
	const on = !!row.connector
	const running = row.state === 'running'
	return [
		grant('apps', on && running, on ? `${name} is not running.` : `Install the connector on ${name} before apps can be installed there.`),
		grant('vms', false, `${name} can’t host its own virtual machines.`),
		grant('files', on, `Install the connector on ${name} before its files can be opened.`),
		grant('storage', false, `Storage stays on the computer that hosts ${name}.`),
		grant('terminal', on, `Install the connector on ${name} before a terminal can open there.`),
		grant('desktop', false, `${name} is a system container and has no desktop.`),
		grant('backups', on, `Install the connector on ${name} before folder backups can run there.`),
	]
}

function serverAbilities(name: string, vms: boolean): FleetAbility[] {
	return KEYS.map((key) => {
		if (key === 'vms' && !vms) return grant(key, false, `${name} can’t run virtual machines right now.`)
		return grant(key, true, '')
	})
}

export function computerFleetInput(row: ComputerFleetInput): ComputerFleetInput {
	return {id: row.id, name: row.name, online: row.online, allowed: row.allowed, on: row.on, libvirt: row.libvirt === true}
}

export function guestFleetInput(row: GuestFleetInput): GuestFleetInput {
	return {id: row.id, name: row.name, state: row.state, hostId: row.hostId, connector: !!row.connector}
}

export function containerFleetInput(row: ContainerFleetInput): ContainerFleetInput {
	return {id: row.id, name: row.name, state: row.state, hostId: row.hostId, hostName: row.hostName, connector: !!row.connector}
}

export function fleetList(input: {
	server: ServerFleetInput
	computers: readonly ComputerFleetInput[]
	guests: readonly GuestFleetInput[]
	containers?: readonly ContainerFleetInput[]
}): FleetMember[] {
	const serverName = input.server.name.trim() || 'This server'
	const serverOnline = input.server.online !== false
	const server: FleetMember = {
		id: SERVER_FLEET_ID,
		kind: 'server',
		name: serverName,
		online: serverOnline,
		entrypoint: true,
		hostId: '',
		meta: `Computer · entrypoint · ${serverOnline ? 'online' : 'offline'}`,
		abilities: serverAbilities(serverName, input.server.vms !== false),
	}
	const computers: FleetMember[] = input.computers.map((row) => ({
		id: row.id,
		kind: 'computer',
		name: row.name,
		online: row.online,
		entrypoint: false,
		hostId: '',
		meta: `Computer · ${row.online ? 'online' : 'offline'}`,
		abilities: computerAbilities(row),
	}))
	const guests: FleetMember[] = input.guests.map((row) => {
		const online = row.state === 'running'
		return {
			id: row.id,
			kind: 'guest',
			name: row.name,
			online,
			entrypoint: false,
			hostId: row.hostId || SERVER_FLEET_ID,
			meta: `Virtual machine · ${online ? 'running' : row.state || 'stopped'}`,
			abilities: guestAbilities(row),
		}
	})
	const containers: FleetMember[] = (input.containers ?? []).map((row) => {
		const online = row.state === 'running'
		const onHost =
			row.hostId && row.hostId !== SERVER_FLEET_ID && row.hostName?.trim()
				? `Container · on ${row.hostName.trim()} · ${containerStatusWord(row.state)}`
				: `Container · ${containerStatusWord(row.state)}`
		return {
			id: row.id,
			kind: 'container',
			name: row.name,
			online,
			entrypoint: false,
			hostId: row.hostId || SERVER_FLEET_ID,
			meta: onHost,
			abilities: containerAbilities(row),
		}
	})
	const all = [server, ...computers, ...guests, ...containers]
	return [...all.filter((m) => m.online).sort(byName), ...all.filter((m) => !m.online).sort(byName)]
}

export function fleetAbility(member: FleetMember, key: FleetAbilityKey): FleetAbility {
	return member.abilities.find((a) => a.key === key) ?? {key, granted: false, reason: ''}
}
