// Keep floating desktop windows inside the visible work area across viewport and dock changes.
export type WindowRect = {x: number; y: number; w: number; h: number}

export const TITLE_BAR_HEIGHT = 42

export function clampWindowRect(
	rect: WindowRect,
	workArea: WindowRect,
	{minW = 380, minH = 260, titleBarHeight = TITLE_BAR_HEIGHT}: {minW?: number; minH?: number; titleBarHeight?: number} = {},
): WindowRect {
	const maxW = Math.max(0, workArea.w)
	const maxH = Math.max(0, workArea.h)
	const w = Math.min(maxW, Math.max(Math.min(minW, maxW), rect.w))
	const h = Math.min(maxH, Math.max(Math.min(minH, maxH), rect.h))
	const maxX = Math.max(workArea.x, workArea.x + maxW - w)
	const maxY = Math.max(workArea.y, workArea.y + maxH - Math.min(h, titleBarHeight))
	const x = Math.min(maxX, Math.max(workArea.x, rect.x))
	const y = Math.min(maxY, Math.max(workArea.y, rect.y))
	return x === rect.x && y === rect.y && w === rect.w && h === rect.h ? rect : {x, y, w, h}
}

export function clampDragY(y: number, workArea: WindowRect, titleBarHeight = TITLE_BAR_HEIGHT): number {
	const maxY = Math.max(workArea.y, workArea.y + Math.max(0, workArea.h) - titleBarHeight)
	return Math.min(maxY, Math.max(workArea.y, y))
}
