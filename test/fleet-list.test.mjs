import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {batteryGroups, batterySweep, computerSample, fleetRings, samplePercent, serverSample} from '../web/src/fleet/aggregate.ts'
import {hostedVms} from '../web/src/fleet/hostedVms.ts'
import {computerParent, computerPlacePath, filePlaces, filesParent, guestPlacePath, parseComputerPlace, parseGuestPlace, scopeRoot, SERVER_FILES, withinScope} from '../web/src/fleet/filePlaces.ts'
import {fittingCrumbCount} from '../web/src/fleet/fittingCrumbs.ts'
import {groupApps} from '../web/src/fleet/groupApps.ts'
import {computerFleetInput, containerFleetInput, fleetAbility, fleetList, guestFleetInput, SERVER_FLEET_ID} from '../web/src/fleet/list.ts'
import {hasPin, loadPins, togglePin} from '../web/src/fleet/pins.ts'

test('the fleet list is online names, then offline names', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [
			computerFleetInput({id: 'kitchen', name: 'Kitchen', online: true, allowed: {files: true, terminal: true}, on: {files: true, terminal: true}}),
			computerFleetInput({id: 'garage', name: 'Garage', online: false, allowed: {files: true}, on: {files: true}}),
			computerFleetInput({id: 'loft', name: 'Loft', online: true}),
		],
		guests: [
			guestFleetInput({id: 'ubuntu', name: 'Ubuntu lab', state: 'running', connector: true}),
			guestFleetInput({id: 'haos', name: 'HA OS', state: 'running'}),
			guestFleetInput({id: 'win', name: 'Windows', state: 'stopped', connector: true}),
		],
	})
	assert.deepEqual(
		members.map((m) => [m.id, m.kind, m.online]),
		[
			[SERVER_FLEET_ID, 'server', true],
			['haos', 'guest', true],
			['kitchen', 'computer', true],
			['loft', 'computer', true],
			['ubuntu', 'guest', true],
			['garage', 'computer', false],
			['win', 'guest', false],
		],
	)
	assert.equal(members[0].meta, 'Computer · entrypoint · online')
	assert.equal(members[0].entrypoint, true)
	assert.equal(members.find((m) => m.id === 'haos')?.hostId, SERVER_FLEET_ID)
	assert.equal(members.find((m) => m.id === 'haos')?.meta, 'Virtual machine · running')
	assert.equal(members.find((m) => m.id === 'win')?.meta, 'Virtual machine · stopped')
	const loft = members.find((m) => m.id === 'loft')
	assert.equal(fleetAbility(loft, 'apps').granted, true)
	assert.match(fleetAbility(members.find((m) => m.id === 'garage'), 'apps').reason, /offline/)
	assert.equal(fleetAbility(loft, 'files').granted, false)
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'files').granted, true)
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').granted, false)
	assert.match(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').reason, /can’t host/)
	assert.equal(fleetAbility(members.find((m) => m.id === 'loft'), 'vms').granted, false)
	assert.equal(fleetAbility(members.find((m) => m.id === 'garage'), 'vms').granted, false)
	assert.equal(fleetAbility(members.find((m) => m.id === 'haos'), 'vms').granted, false)
	const haos = members.find((m) => m.id === 'haos')
	assert.match(fleetAbility(haos, 'apps').reason, /connector on HA OS/)
	assert.equal(fleetAbility(haos, 'storage').granted, false)
	assert.equal(fleetAbility(members.find((m) => m.id === 'ubuntu'), 'apps').granted, true)
	assert.equal(fleetAbility(members[0], 'apps').granted, true)
})

test('fleetList keeps a container hostId when it runs on a joined computer', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [computerFleetInput({id: 'kitchen', name: 'Kitchen', online: true})],
		guests: [],
		containers: [containerFleetInput({id: 'edge', name: 'edge', state: 'running', hostId: 'kitchen'})],
	})
	const c = members.find((m) => m.id === 'edge')
	assert.equal(c?.hostId, 'kitchen')
})

test('fleetList includes containers hosted on this server', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [],
		guests: [],
		containers: [containerFleetInput({id: 'web', name: 'web', state: 'running', connector: true})],
	})
	const c = members.find((m) => m.kind === 'container')
	assert.ok(c)
	assert.equal(c.id, 'web')
	assert.equal(c.online, true)
	assert.equal(c.hostId, SERVER_FLEET_ID)
	assert.match(c.meta, /Container/i)
	assert.match(c.meta, /online/)
	assert.equal(fleetAbility(c, 'desktop').granted, false)
	assert.equal(fleetAbility(c, 'storage').granted, false)
	assert.equal(fleetAbility(c, 'vms').granted, false)
	assert.equal(fleetAbility(c, 'files').granted, true)
	assert.equal(fleetAbility(c, 'terminal').granted, true)
	assert.equal(fleetAbility(c, 'apps').granted, true)
	assert.equal(fleetAbility(c, 'backups').granted, true)
	const paused = fleetList({
		server: {name: 'Den'},
		computers: [],
		guests: [],
		containers: [containerFleetInput({id: 'db', name: 'db', state: 'frozen'})],
	}).find((m) => m.kind === 'container')
	assert.equal(paused?.online, false)
	assert.match(paused?.meta ?? '', /paused/)
	const starting = fleetList({
		server: {name: 'Den'},
		computers: [],
		guests: [],
		containers: [containerFleetInput({id: 'app', name: 'app', state: 'starting'})],
	}).find((m) => m.kind === 'container')
	assert.match(starting?.meta ?? '', /Starting/)
})

test('vms is granted only when the computer is online, allowed, on, and libvirt is there', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [
			computerFleetInput({id: 'kitchen', name: 'Kitchen', online: true, allowed: {vms: true}, on: {vms: true}, libvirt: true}),
			computerFleetInput({id: 'loft', name: 'Loft', online: true, allowed: {vms: true}, on: {vms: true}, libvirt: false}),
			computerFleetInput({id: 'garage', name: 'Garage', online: false, allowed: {vms: true}, on: {vms: true}, libvirt: true}),
			computerFleetInput({id: 'nook', name: 'Nook', online: true, allowed: {vms: true}, on: {vms: false}, libvirt: true}),
		],
		guests: [guestFleetInput({id: 'box', name: 'Box', state: 'running', hostId: 'kitchen'})],
	})
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').granted, true)
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').reason, '')
	for (const id of ['loft', 'garage', 'nook', 'box']) {
		const ability = fleetAbility(members.find((m) => m.id === id), 'vms')
		assert.equal(ability.granted, false, id)
		assert.match(ability.reason, /can’t host its own virtual machines/)
	}
	assert.equal(members.find((m) => m.id === 'box').hostId, 'kitchen')
})

test('home rings weight CPU by cores, keep the hottest temperature, and share close batteries', () => {
	const rings = fleetRings([
		serverSample({name: 'Den', cores: 4, cpu: 50, memUsed: 4, memTotal: 8, diskUsed: 10, diskTotal: 100, temp: 40, gpus: [{id: 'g', used: 80}], battery: null}),
		computerSample({
			id: 'kitchen',
			name: 'Kitchen',
			online: true,
			metrics: {cpu: 10, cores: 8, mem: {used: 2, total: 8}, disks: [{mount: '/', used: 50, total: 100}], gpus: [{id: 'k', used: 20}], temp: 70},
		}),
		computerSample({id: 'loft', name: 'Loft', online: true, metrics: {cpu: 5, cores: 4, batteries: [{id: 'b', index: 0, name: 'BAT0', percent: 18, status: 'discharging', secondsRemaining: null, power: null, energyNow: null, energyFull: null}]}}),
		computerSample({id: 'nook', name: 'Nook', online: true, metrics: {cpu: 5, cores: 4, batteries: [{id: 'b', index: 0, name: 'BAT0', percent: 21, status: 'discharging', secondsRemaining: null, power: null, energyNow: null, energyFull: null}]}}),
		computerSample({id: 'patio', name: 'Patio', online: true, metrics: {cpu: 5, cores: 4, batteries: [{id: 'b', index: 0, name: 'BAT0', percent: 76, status: 'discharging', secondsRemaining: null, power: null, energyNow: null, energyFull: null}]}}),
		computerSample({id: 'garage', name: 'Garage', online: false, metrics: {cpu: 99, cores: 32, temp: 99}}),
	])
	// (4*50 + 8*10 + 4*5 + 4*5 + 4*5) / 24 = 14. Garage's 99 stays out.
	assert.equal(rings.cpu.percent, 14)
	assert.equal(rings.cpu.busiest, 'Den')
	assert.equal(rings.temp?.celsius, 70)
	assert.equal(rings.temp?.name, 'Kitchen')
	assert.equal(rings.gpu?.percent, 50)
	assert.equal(rings.gpu?.busiest, 'Den')
	assert.equal(rings.battery?.lowest.name, 'Loft')
	assert.equal(rings.battery?.lowest.percent, 18)
	assert.deepEqual(
		rings.battery?.groups.map((g) => [g.percent, g.members.map((m) => m.name).sort()]),
		[
			[76, ['Patio']],
			[20, ['Loft', 'Nook']],
		],
	)
	const shared = rings.battery?.groups[1]
	assert.equal(shared?.members.length, 2)
	assert.notEqual(shared?.members[0].color, shared?.members[1].color)
	const arc = batterySweep(76)
	assert.equal(arc.endLeft, true)
	assert.equal(batterySweep(20).endLeft, false)
	assert.equal(batteryGroups([{id: 'a', name: 'A', percent: 50}, {id: 'b', name: 'B', percent: 40}]).length, 2)
})

test('pins round-trip and apps stay in arrival order', () => {
	assert.deepEqual(loadPins(null), [])
	assert.deepEqual(loadPins('nope'), [])
	assert.deepEqual(loadPins(JSON.stringify([{kind: 'nope'}, {kind: 'app', id: 'jellyfin', computer: 'server'}])), [{kind: 'app', id: 'jellyfin', computer: 'server'}])
	const pin = {kind: 'machine', id: 'kitchen', computer: ''}
	const on = togglePin([], pin)
	assert.equal(hasPin(on, pin), true)
	assert.deepEqual(togglePin(on, pin), [])
	const groups = groupApps([
		{appId: 'jellyfin', name: 'Jellyfin', computerId: 'server', computerName: 'Den'},
		{appId: 'code', name: 'Code', computerId: 'server', computerName: 'Den'},
		{appId: 'jellyfin', name: 'Jellyfin', computerId: 'kitchen', computerName: 'Kitchen'},
	])
	assert.deepEqual(groups.map((g) => g.appId), ['jellyfin', 'code'])
	assert.deepEqual(groups[0].instances.map((i) => i.computerName), ['Den', 'Kitchen'])
	assert.equal(groups[1].instances.length, 1)
})

test('file places list only machines whose files can be read', () => {
	const {places} = filePlaces(
		[
			{id: 'kitchen', name: 'Kitchen', online: true, filesGranted: true},
			{id: 'loft', name: 'Loft', online: true, filesGranted: false},
			{id: 'garage', name: 'Garage', online: false, filesGranted: true},
		],
		[
			{id: 'vm1', name: 'Ubuntu', state: 'running', agentId: 'agentvm', filesGranted: true},
			{id: 'vm2', name: 'Stopped', state: 'stopped', agentId: 'agentoff', filesGranted: true},
			{id: 'vm3', name: 'Plain', state: 'running'},
		],
	)
	assert.deepEqual(places, [
		{id: 'kitchen', name: 'Kitchen', path: '::computer/kitchen', kind: 'computer', browsable: true},
		{id: 'agentvm', name: 'Ubuntu', path: '::computer/agentvm', kind: 'computer', browsable: true},
	])
	const den = serverSample({name: 'Den', cores: 4, cpu: 10, memUsed: 1, memTotal: 4, diskUsed: 2, diskTotal: 8, temp: null, gpus: [{id: 'g0', used: 40}], battery: 55})
	assert.equal(samplePercent(den, 'CPU'), 10)
	assert.equal(samplePercent(den, 'Memory'), 25)
	assert.equal(samplePercent(den, 'Storage'), 25)
	assert.equal(samplePercent(den, 'GPU'), 40)
	assert.equal(samplePercent(den, 'GPU', 'missing'), 40)
	assert.equal(samplePercent(den, 'Battery'), 55)
	assert.equal(samplePercent({...den, cpu: null, gpus: [], battery: null}, 'GPU'), null)
	assert.deepEqual(parseComputerPlace('::computer/kitchen/Photos/2024'), {id: 'kitchen', rel: 'Photos/2024'})
	assert.equal(parseComputerPlace('::computer/kitchen/../secret'), null)
	assert.equal(parseComputerPlace('::computer/..'), null)
	assert.equal(parseComputerPlace('::computer/../secret'), null)
	assert.equal(parseComputerPlace('::computer/.'), null)
	assert.equal(parseComputerPlace('::computer/a\\b'), null)
	assert.equal(computerPlacePath('..'), null)
	assert.equal(computerPlacePath('..', 'secret'), null)
	assert.equal(computerPlacePath(''), null)
	assert.equal(computerPlacePath('a/b'), null)
	assert.equal(computerParent(computerPlacePath('kitchen', 'Photos/2024')), '::computer/kitchen/Photos')
	assert.equal(computerParent('::computer/kitchen'), null)
	assert.equal(computerPlacePath('kitchen').startsWith('/'), false)
	assert.equal(parseComputerPlace(SERVER_FILES), null)
	assert.equal(filesParent(SERVER_FILES), null)
	assert.equal(filesParent('/Home'), SERVER_FILES)
	assert.equal(filesParent('/Home/Photos'), '/Home')
	assert.equal(filesParent('::recents'), SERVER_FILES)
	assert.equal(filesParent('::computer/kitchen'), null)
	assert.equal(filesParent('::computer/kitchen/Photos'), '::computer/kitchen')
	assert.equal(filesParent('::guest/vm1'), null)
	assert.deepEqual(parseGuestPlace('::guest/vm1'), {id: 'vm1'})
	assert.equal(parseGuestPlace('::guest/vm1/disk'), null)
	assert.equal(parseGuestPlace('::guest/..'), null)
	assert.equal(guestPlacePath('..'), null)
	assert.equal(guestPlacePath(''), null)
	const server = {kind: 'server'}
	const kitchen = {kind: 'computer', id: 'kitchen', name: 'Kitchen'}
	assert.equal(scopeRoot(server), SERVER_FILES)
	assert.equal(scopeRoot(kitchen), '::computer/kitchen')
	assert.equal(withinScope(server, null), SERVER_FILES)
	assert.equal(withinScope(server, '::computer/kitchen'), SERVER_FILES)
	assert.equal(withinScope(server, '::guest/vm1'), SERVER_FILES)
	assert.equal(withinScope(server, '/Home/Photos'), '/Home/Photos')
	assert.equal(withinScope(kitchen, '/Home'), '::computer/kitchen')
	assert.equal(withinScope(kitchen, '::computer/loft'), '::computer/kitchen')
	assert.equal(withinScope(kitchen, '::computer/kitchen/Photos'), '::computer/kitchen/Photos')
	assert.equal(withinScope(undefined, null), null)
	assert.equal(fittingCrumbCount([10, 20, 30], 100), 3)
	assert.equal(fittingCrumbCount([10, 20, 30], 50), 2)
	assert.equal(fittingCrumbCount([10, 20, 30], 35), 1)
	assert.equal(fittingCrumbCount([80], 40), 1)
	assert.equal(fittingCrumbCount([], 40), 0)
})

test('hostedVms splits this server from a joined computer', () => {
	const list = [
		{id: 'a', hostId: 'server'},
		{id: 'b'},
		{id: 'c', hostId: 'abc123abc123'},
	]
	assert.deepEqual(hostedVms(list, 'server').map((m) => m.id), ['a', 'b'])
	assert.deepEqual(hostedVms(list, 'abc123abc123').map((m) => m.id), ['c'])
})

test('CreateMachine does not keep the remote stub copy', async () => {
	const text = await readFile(new URL('../web/src/CreateMachine.tsx', import.meta.url), 'utf8')
	assert.equal(text.includes('can’t host a virtual machine yet'), false)
	assert.equal(text.includes('function RemoteVmHost'), false)
	assert.match(text, /hostId: host\.id/)
	assert.match(text, /The operating system is downloaded on/)
	assert.match(text, /ISO from this server/)
})
