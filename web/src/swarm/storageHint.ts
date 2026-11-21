// Subtitle for the Storage row in a swarm computer's sheet.
// Only ask for re-pairing when Storage wasn't allowed at pairing; if it was allowed
// and merely switched off under Allowed here, point at the switch below.
export function storageRowSub(allowed: boolean, on: boolean): string {
	if (!allowed) return 'Pair this computer again with Storage switched on.'
	if (!on) return 'Switched off here. Turn Storage on under Allowed here.'
	return 'Drives, format extra disks, and pools on this computer'
}
