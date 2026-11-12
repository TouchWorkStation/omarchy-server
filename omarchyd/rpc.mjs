// The wire format omarchyd speaks: one procedure per request at /trpc/<name>, queries as GET with
// ?input=<json>, mutations as POST with a JSON body, answers as {result: {data}} or {error: {...}}.
// It is the same shape the Touch server already talks, so the web app runs on omarchyd unchanged.

export class RpcError extends Error {
	constructor(code, message) {
		super(message)
		this.code = code
	}
}
const HTTP = {BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412, TOO_MANY_REQUESTS: 429, METHOD_NOT_SUPPORTED: 405}

export function sendJson(res, status, body, headers = {}) {
	const text = JSON.stringify(body)
	res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers})
	res.end(text)
}
export function sendError(res, error) {
	const code = error instanceof RpcError ? error.code : 'INTERNAL_SERVER_ERROR'
	const message = error instanceof RpcError ? error.message : 'Internal error'
	if (!(error instanceof RpcError)) console.error('[omarchyd]', error)
	const httpStatus = HTTP[code] ?? 500
	sendJson(res, httpStatus, {error: {message, code: -32000, data: {code, httpStatus}}})
}

async function readBody(req, limit = 1_000_000) {
	let size = 0
	const chunks = []
	for await (const c of req) {
		size += c.length
		if (size > limit) throw new RpcError('BAD_REQUEST', 'Request too large')
		chunks.push(c)
	}
	return Buffer.concat(chunks).toString('utf8')
}

// procedures: {'name': {kind: 'query'|'mutation', public?: true, run(input, ctx)}}
export async function handleRpc(req, res, url, procedures, authenticate) {
	const name = url.pathname.slice('/trpc/'.length)
	const proc = Object.hasOwn(procedures, name) ? procedures[name] : null
	try {
		if (!proc) throw new RpcError('NOT_FOUND', `No procedure found on path "${name}"`)
		if ((proc.kind === 'query') !== (req.method === 'GET')) throw new RpcError('METHOD_NOT_SUPPORTED', 'Wrong method')
		let input
		if (req.method === 'GET') {
			const raw = url.searchParams.get('input')
			input = raw === null ? undefined : JSON.parse(raw)
		} else {
			const body = await readBody(req)
			input = body ? JSON.parse(body) : undefined
		}
		const ctx = {req, res, auth: null}
		if (!proc.public) {
			ctx.auth = authenticate(req)
			if (!ctx.auth) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		}
		const data = await proc.run(input, ctx)
		sendJson(res, 200, {result: {data: data ?? null}})
	} catch (error) {
		if (error instanceof SyntaxError) return sendError(res, new RpcError('BAD_REQUEST', 'Invalid JSON'))
		sendError(res, error)
	}
}
