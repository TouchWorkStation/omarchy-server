declare module '@novnc/novnc/lib/rfb.js' {
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: {shared?: boolean})
		scaleViewport: boolean
		resizeSession: boolean
		viewOnly: boolean
		background: string
		focusOnClick: boolean
		disconnect(): void
		focus(): void
		blur(): void
		sendKey(keysym: number, code: string | null, down?: boolean): void
		sendCtrlAltDel(): void
	}
}
