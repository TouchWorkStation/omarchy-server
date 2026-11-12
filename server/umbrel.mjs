// Minimal client for umbreld's tRPC v11 HTTP API (no transformer, plain JSON).
//
// Wire format, verified against getumbrel/umbrel (umbrelOS 2.0, commit 9298257b):
//   query    GET  /trpc/<path>?input=<urlencoded JSON>   (omit input when there is none)
//   mutation POST /trpc/<path>  body = JSON input
//   success  {"result":{"data":<value>}}
//   failure  {"error":{"message":"...","code":-32001,"data":{"code":"UNAUTHORIZED","httpStatus":401}}}

export class UmbrelError extends Error {
	constructor(message, {code = 'INTERNAL_SERVER_ERROR', status = 500, path} = {}) {
		super(message)
		this.name = 'UmbrelError'
		this.code = code
		this.status = status
		this.path = path
	}
}

export function createUmbrelClient({baseUrl, timeoutMs = 20_000, fetchImpl = fetch}) {
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
			throw new UmbrelError(`Can't reach umbrelOS at ${base} (${reason})`, {code: 'UNREACHABLE', status: 502, path})
		}

		const text = await response.text()
		let body
		try {
			body = text ? JSON.parse(text) : {}
		} catch {
			throw new UmbrelError(`umbrelOS returned an unexpected response for ${path} (HTTP ${response.status})`, {
				code: 'BAD_RESPONSE',
				status: 502,
				path,
			})
		}
		if (body?.error) {
			const data = body.error.data ?? {}
			throw new UmbrelError(body.error.message || 'umbrelOS error', {
				code: data.code ?? 'INTERNAL_SERVER_ERROR',
				status: data.httpStatus ?? response.status ?? 500,
				path,
			})
		}
		if (!response.ok) {
			throw new UmbrelError(`umbrelOS returned HTTP ${response.status} for ${path}`, {status: response.status, path})
		}
		const data = body?.result?.data
		// Cookies umbreld set on this response, as `name=value` pairs.
		if (withCookies) return {data, cookies: (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])}
		return data
	}

	return {
		baseUrl: base,
		query: (path, input, options = {}) => call(path, {...options, type: 'query', input}),
		mutation: (path, input, options = {}) => call(path, {...options, type: 'mutation', input}),
	}
}
