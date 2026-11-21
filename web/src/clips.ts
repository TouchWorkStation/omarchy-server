// The clip book keeps text and screenshots through the raw upload routes. Those bodies are larger
// than a JSON call, and a refusal must not sign the person out.

const lastClip = {text: '', at: 0}

async function refusal(res: Response): Promise<Error | null> {
	if (res.ok || res.status === 401 || res.status === 403) return null
	const body = await res.json().catch(() => null)
	const code = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error.code : ''
	if (code === 'CONSOLE_SESSION_REQUIRED' || code === 'UNAUTHORIZED') return null
	const message = body && typeof body === 'object' && body.error && typeof body.error.message === 'string' ? body.error.message : 'Couldn’t add that to the clip book'
	return new Error(message)
}

export async function clipText(text: string, where: 'terminal' | 'desktop', cut = false): Promise<void> {
	if (!text.trim()) return
	const now = Date.now()
	if (text === lastClip.text && now - lastClip.at < 500) return
	lastClip.text = text
	lastClip.at = now
	const params = new URLSearchParams({where})
	if (cut) params.set('cut', '1')
	const res = await fetch(`/api/clips/text?${params}`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: {'content-type': 'application/octet-stream', 'x-omarchy-server': '1'},
		body: text,
	})
	const err = await refusal(res)
	if (err) throw err
}

export async function clipImage(blob: Blob): Promise<void> {
	const res = await fetch('/api/clips/image', {
		method: 'POST',
		credentials: 'same-origin',
		headers: {'content-type': 'application/octet-stream', 'x-omarchy-server': '1'},
		body: blob,
	})
	const err = await refusal(res)
	if (err) throw err
}

export const clipItemUrl = (id: string) => `/api/clips/item?id=${encodeURIComponent(id)}`
