// Align desktop top bar clock refreshes to minute boundaries so minutes and midnight roll over on time.
export function msUntilNextMinute(nowMs: number): number {
	const rem = nowMs % 60_000
	return rem === 0 ? 60_000 : 60_000 - rem
}

export function startMinuteClock<T = ReturnType<typeof setTimeout>>(
	onTick: (date: Date) => void,
	{
		now = () => Date.now(),
		setTimer = ((fn: () => void, ms: number) => setTimeout(fn, ms)) as unknown as (fn: () => void, ms: number) => T,
		clearTimer = ((id: T) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as (id: T) => void,
	}: {
		now?: () => number
		setTimer?: (fn: () => void, ms: number) => T
		clearTimer?: (id: T) => void
	} = {},
): () => void {
	let stopped = false
	let timer: T | null = null
	let lastMinute = Math.floor(now() / 60_000)

	const schedule = () => {
		if (stopped) return
		const delay = msUntilNextMinute(now())
		timer = setTimer(() => {
			if (stopped) return
			const curMs = now()
			const curMinute = Math.floor(curMs / 60_000)
			if (curMinute !== lastMinute) {
				lastMinute = curMinute
				onTick(new Date(curMs))
			}
			schedule()
		}, delay)
	}

	schedule()
	return () => {
		stopped = true
		if (timer !== null) {
			clearTimer(timer)
			timer = null
		}
	}
}
