// Minimal client for omarchyd's tRPC v11 HTTP API (no transformer, plain JSON).
//
// Wire format: plain tRPC v11 over HTTP, as omarchyd speaks it:
//   query    GET  /trpc/<path>?input=<urlencoded JSON>   (omit input when there is none)
//   mutation POST /trpc/<path>  body = JSON input
//   success  {"result":{"data":<value>}}
//   failure  {"error":{"message":"...","code":-32001,"data":{"code":"UNAUTHORIZED","httpStatus":401}}}

export class BackendError extends Error {
	constructor(message, {code = 'INTERNAL_SERVER_ERROR', status = 500, path} = {}) {
		super(message)
		this.name = 'BackendError'
		this.code = code
		this.status = status
		this.path = path
	}
}

export function createBackendClient({baseUrl, timeoutMs = 20_000, fetchImpl = fetch}) {
	const base = baseUrl.replace(/\/+$/, '')

	async function call(path, {type, input, token, cookie, userAgent, timeout = timeoutMs, withCookies = false} = {}) {
		let url = `${base}/trpc/${path}`
		const headers = {accept: 'application/json'}
		if (token) headers.authorization = `Bearer ${token}`
		if (userAgent) headers['user-agent'] = userAgent
		if (cookie) headers.cookie = cookie
		const init = {method: type === 'mutation' ? 'POST' : 'GET', headers, redirect: 'follow'}
		if (type === 'mutation') {
			headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) {
			url += `?input=${encodeURIComponent(JSON.stringify(input))}`
		}

		let response
		try {
			response = await fetchImpl(url, {...init, signal: AbortSignal.timeout(timeout)})
		} catch (error) {
			const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.cause?.code ?? error?.message ?? 'failed')
			throw new BackendError(`Can't reach Omarchy Server at ${base} (${reason})`, {code: 'UNREACHABLE', status: 502, path})
		}

		const text = await response.text()
		let body
		try {
			body = text ? JSON.parse(text) : {}
		} catch {
			throw new BackendError(`Omarchy Server returned an unexpected response for ${path} (HTTP ${response.status})`, {
				code: 'BAD_RESPONSE',
				status: 502,
				path,
			})
		}
		if (body?.error) {
			const data = body.error.data ?? {}
			throw new BackendError(body.error.message || 'Omarchy Server error', {
				code: data.code ?? 'INTERNAL_SERVER_ERROR',
				status: data.httpStatus ?? response.status ?? 500,
				path,
			})
		}
		if (!response.ok) {
			throw new BackendError(`Omarchy Server returned HTTP ${response.status} for ${path}`, {status: response.status, path})
		}
		const data = body?.result?.data
		// Cookies omarchyd set on this response, as `name=value` pairs.
		if (withCookies) return {data, cookies: (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])}
		return data
	}

	return {
		baseUrl: base,
		query: (path, input, options = {}) => call(path, {...options, type: 'query', input}),
		mutation: (path, input, options = {}) => call(path, {...options, type: 'mutation', input}),
	}
}
