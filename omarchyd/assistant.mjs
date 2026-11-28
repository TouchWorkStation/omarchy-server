import {createChatGpt} from './assistant/chatgpt.mjs'
import {createConversations} from './assistant/conversations.mjs'
import {createKeyStore, customBasePermitted, normalizeBaseUrl, presetBaseUrl} from './assistant/keys.mjs'
import {createLoop, publicAction} from './assistant/loop.mjs'
import {callMcpTool} from './assistant/mcp.mjs'
import {verifyKey} from './assistant/providers.mjs'
import {coerceDeskShell, declaredArgs, writeTool} from './assistant/tools.mjs'
import {RpcError} from './rpc.mjs'

async function readJson(req, limit) {
	let size = 0
	const chunks = []
	for await (const c of req) {
		size += c.length
		if (size > limit) throw new RpcError('BAD_REQUEST', 'Request too large')
		chunks.push(c)
	}
	const raw = Buffer.concat(chunks).toString('utf8')
	if (!raw) return {}
	try {
		const body = JSON.parse(raw)
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('not an object')
		return body
	} catch (error) {
		if (error instanceof RpcError) throw error
		throw new RpcError('BAD_REQUEST', 'Invalid JSON')
	}
}

function stripSecrets(value) {
	if (Array.isArray(value)) return value.map(stripSecrets)
	if (!value || typeof value !== 'object') return value
	const out = {}
	for (const [k, v] of Object.entries(value)) {
		if (k === 'password' || k === 'apiKey' || k === 'credentials' || k === 'defaultPassword' || k === 'accessToken' || k === 'refreshToken' || k === 'idToken') continue
		out[k] = stripSecrets(v)
	}
	return out
}

function hide(text, secret) {
	const s = String(text ?? '')
	if (!secret) return s
	return s.split(secret).join('')
}

function toolText(result, secret) {
	const clean = result && typeof result === 'object' ? stripSecrets(result) : result
	const text = typeof clean === 'string' ? clean : JSON.stringify(clean ?? null)
	return hide(text, secret)
}

function ownerMessage(toolName) {
	if (toolName === 'system_restart') return 'Only the server’s owner can restart the server'
	if (toolName === 'system_shutdown') return 'Only the server’s owner can shut down the server'
	if (toolName === 'omarchy_installPlugin') return 'Only the server’s owner can install Omarchy plugins'
	if (toolName === 'omarchy_removePlugin') return 'Only the server’s owner can remove Omarchy plugins'
	if (toolName === 'omarchy_setBackground') return 'Only the server’s owner can change the wallpaper'
	if (String(toolName ?? '').startsWith('swarm_')) return 'Only the server’s owner can manage the local swarm'
	return 'Only the server’s owner can change the desktop’s theme'
}

export function createAssistant({dataDir, accounts, now, runProcedure, fetchImpl, mcpTargets, sleep, chatgptOptions = {}, turnIdleMs = 600_000, turnMaxMs = 1_800_000}) {
	const keys = createKeyStore({dataDir, now})
	const conversations = createConversations({dataDir, now, recoverRunning: true})
	const chatgpt = createChatGpt({dataDir, keys, fetchImpl: fetchImpl ?? fetch, ...(now ? {now} : {}), ...chatgptOptions})
	const stamp = () => (now ? now() : Date.now())
	const actor = (auth) => {
		const u = accounts.getUser(auth?.userId)
		if (!u) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return {userId: u.userId, role: u.role}
	}
	const userIdOf = (auth) => {
		if (!auth?.userId) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return auth.userId
	}
	const {runTurn, runTurnContinue} = createLoop({keys, conversations, runProcedure, fetchImpl, mcpTargets, chatgpt, now, sleep})
	const inflight = new Set()
	const claim = (id) => {
		if (inflight.has(id)) throw new RpcError('CONFLICT', 'That step was already handled')
		inflight.add(id)
	}
	const actionId = (input) => {
		const id = String(input?.actionId ?? '').trim()
		if (!id) throw new RpcError('BAD_REQUEST', 'Missing action')
		return id
	}
	const appendOutcome = (who, action, content) => {
		if (!action.toolCallId) return null
		return conversations.append(who.userId, action.conversationId, {
			role: 'tool',
			toolCallId: action.toolCallId,
			name: action.toolName,
			content: String(content ?? ''),
			at: stamp(),
		})
	}
	async function approveMcp(who, action, running) {
		const spec = action.mcp
		const tool = typeof spec?.tool === 'string' ? spec.tool : ''
		const args = spec?.arguments && typeof spec.arguments === 'object' && !Array.isArray(spec.arguments) ? spec.arguments : {}
		const fail = async (error, code) => {
			await conversations.saveAction(who.userId, {...running, status: 'error', error, resolvedAt: stamp()})
			await appendOutcome(who, action, error)
			throw new RpcError(code, error)
		}
		if (!spec || typeof spec !== 'object' || !spec.appId || !tool) return fail('That step is not available', 'PRECONDITION_FAILED')
		let targets = []
		try {
			targets = typeof mcpTargets === 'function' ? await mcpTargets() : []
		} catch {
			targets = []
		}
		const target = Array.isArray(targets) ? targets.find((t) => t && t.appId === spec.appId && t.running !== false && typeof t.url === 'string' && t.url) : null
		if (!target) return fail('That app is not running', 'PRECONDITION_FAILED')
		let result
		try {
			result = await callMcpTool({url: target.url, name: tool, arguments: args, fetchImpl})
		} catch (e) {
			if (e instanceof RpcError) return fail(e.message, e.code)
			return fail(e?.message || 'That step failed', 'BAD_GATEWAY')
		}
		const done = {...running, status: 'done', resolvedAt: stamp()}
		delete done.error
		await conversations.saveAction(who.userId, done)
		await appendOutcome(who, action, toolText(result, ''))
		return publicAction(done)
	}
	function personGrant(value) {
		if (!Array.isArray(value)) return null
		const out = []
		for (const item of value) {
			if (out.length >= 32) break
			const s = String(item ?? '').trim()
			if (!s || s.length > 64 || out.includes(s)) continue
			out.push(s)
		}
		return out
	}
	function personFolders(value) {
		if (!Array.isArray(value)) return null
		const out = []
		for (const item of value) {
			if (out.length >= 32) break
			if (!item || typeof item !== 'object') continue
			const appId = String(item.appId ?? '').trim()
			const id = String(item.id ?? '').trim()
			const path = String(item.path ?? '').trim()
			if (!appId || !id || !path || appId.length > 200 || id.length > 200 || path.length > 4096) continue
			out.push({appId, id, path})
		}
		return out
	}
	function personFolderAccess(value) {
		if (!Array.isArray(value)) return null
		const out = []
		for (const item of value) {
			if (out.length >= 32) break
			if (!item || typeof item !== 'object') continue
			const id = String(item.id ?? '').trim()
			const sourcePath = String(item.sourcePath ?? '').trim()
			if (!id || !sourcePath || id.length > 200 || sourcePath.length > 4096) continue
			out.push({id, sourcePath})
		}
		return out
	}
	async function approve(input, {auth}) {
		const who = actor(auth)
		const id = actionId(input)
		claim(id)
		try {
			const {action} = await conversations.getAction(who.userId, id)
			if (action.status !== 'pending') throw new RpcError('CONFLICT', 'That step was already handled')
			const spec = writeTool(action.toolName)
			if ((action.ownerOnly || spec?.ownerOnly) && who.role !== 'owner') {
				const error = ownerMessage(action.toolName)
				await conversations.saveAction(who.userId, {...action, status: 'error', error, resolvedAt: stamp()})
				throw new RpcError('FORBIDDEN', error)
			}
			const path = action.rpc?.path || spec?.rpc
			const rpcInput = {...(action.rpc?.input && typeof action.rpc.input === 'object' && !Array.isArray(action.rpc.input) ? action.rpc.input : {})}
			delete rpcInput.password
			if (spec) {
				const kept = declaredArgs(spec, rpcInput)
				for (const key of Object.keys(rpcInput)) if (!Object.hasOwn(kept, key)) delete rpcInput[key]
			}
			// The model cannot attach grant. The person allows it on the store's install review, and that
			// choice arrives on this Approve call.
			if (action.toolName === 'apps_install') {
				const grant = personGrant(input?.grant)
				if (grant?.length) rpcInput.grant = grant
				const folders = personFolders(input?.folders)
				if (folders?.length) rpcInput.folders = folders
				const folderAccess = personFolderAccess(input?.folderAccess)
				if (folderAccess?.length) rpcInput.folderAccess = folderAccess
			}
			if (action.toolName === 'omarchy_setBackground') {
				const chosen = String(input?.id ?? rpcInput.id ?? '').trim()
				if (!/^[0-9a-f]{16}$/.test(chosen)) throw new RpcError('BAD_REQUEST', 'Pick a wallpaper first')
				rpcInput.id = chosen
			}
			// A new machine's password is typed on the Approve card and passed only into the RPC: never
			// stored, and the model never sees it. Checked before the step starts, so it stays open.
			const vm = action.toolName === 'machines_create' || path === 'machines.create'
			const secret = vm ? String(input?.password ?? '') : ''
			if (vm && (secret.length < 1 || secret.length > 256 || /[\r\n]/.test(secret))) throw new RpcError('BAD_REQUEST', 'Enter a password for the machine')
			if (action.toolName === 'desktop_setLayout') {
				const shell = coerceDeskShell(rpcInput.shell)
				if (!shell) throw new RpcError('BAD_REQUEST', 'Use gnome (Ubuntu) or hyprland')
				rpcInput.shell = shell
			}
			const running = {...action, status: 'running', rpc: action.rpc ? {...action.rpc, input: {...rpcInput}} : action.rpc}
			await conversations.saveAction(who.userId, running)
			// Await so the in-flight lock stays until the MCP call finishes. A bare return would run finally first.
			if (action.kind === 'mcp') return await approveMcp(who, action, running)
			if (action.toolName === 'desktop_setLayout') {
				const done = {...running, status: 'done', resolvedAt: stamp()}
				delete done.error
				await conversations.saveAction(who.userId, done)
				await appendOutcome(who, action, JSON.stringify({shell: rpcInput.shell}))
				return publicAction(done)
			}
			if (secret) rpcInput.password = secret
			let result
			try {
				if (!runProcedure || !path) throw new RpcError('PRECONDITION_FAILED', 'That step is not available')
				result = await runProcedure(path, rpcInput, who)
			} catch (e) {
				const error = hide(e?.message || 'That step failed', secret)
				await conversations.saveAction(who.userId, {...running, status: 'error', error, resolvedAt: stamp()})
				await appendOutcome(who, action, error)
				if (e instanceof RpcError) throw e
				throw new RpcError('BAD_GATEWAY', error)
			}
			const done = {...running, status: 'done', resolvedAt: stamp()}
			delete done.error
			await conversations.saveAction(who.userId, done)
			await appendOutcome(who, action, toolText(result, secret))
			return publicAction(done)
		} finally {
			inflight.delete(id)
		}
	}
	async function reject(input, {auth}) {
		const who = actor(auth)
		const id = actionId(input)
		claim(id)
		try {
			const {action} = await conversations.getAction(who.userId, id)
			if (action.status !== 'pending') throw new RpcError('CONFLICT', 'That step was already handled')
			const rejected = {...action, status: 'rejected', resolvedAt: stamp()}
			await conversations.saveAction(who.userId, rejected)
			await appendOutcome(who, action, 'user rejected this step')
			return publicAction(rejected)
		} finally {
			inflight.delete(id)
		}
	}
	// IncomingMessage 'close' fires when the body is consumed, so that would cancel every turn.
	// Closing the chat window (Super+W) hangs up SSE; lookups must still finish and be saved.
	// A reply now keeps running after the chat closes, so a reload could start a second turn on the
	// same chat while the first is still writing to it. Only one turn runs per chat at a time.
	// A turn that stops producing anything for turnIdleMs, or runs longer than turnMaxMs, is cut off,
	// so a model that never finishes cannot hold the chat's lock for good. The person can also stop it.
	const turning = new Map()
	async function handleStream(req, res, auth) {
		const who = actor(auth)
		const ac = new AbortController()
		let lock = null
		let timedOut = false
		let idle = null
		let total = null
		let ping = null
		const cutOff = () => {
			timedOut = true
			ac.abort()
		}
		const watchIdle = () => {
			clearTimeout(idle)
			idle = setTimeout(cutOff, turnIdleMs)
			idle.unref?.()
		}
		try {
			const body = await readJson(req, 100_000)
			if (ac.signal.aborted) return
			req.socket?.setNoDelay(true)
			res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'})
			// A comment line every 20 s while the model thinks: proxies (Cloudflare closes after ~100 s
			// of silence) keep the stream open. The page skips blocks with no event.
			ping = setInterval(() => {
				if (!res.writableEnded && !res.destroyed) {
					try {
						res.write(': ping\n\n')
					} catch {}
				}
			}, 20_000)
			ping.unref?.()
			const emit = ({event, data}) => {
				watchIdle()
				if (res.writableEnded || res.destroyed) return
				try {
					res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
				} catch {
					/* client hung up */
				}
			}
			const conversationId = body.conversationId ? String(body.conversationId) : ''
			if (conversationId) {
				const key = `${who.userId}\u0000${conversationId}`
				if (turning.has(key)) {
					emit({event: 'error', data: {message: 'This chat is still answering. Wait for it to finish, then try again.'}})
					return
				}
				turning.set(key, ac)
				lock = key
			}
			watchIdle()
			total = setTimeout(cutOff, turnMaxMs)
			total.unref?.()
			const turn = body.continue === true ? runTurnContinue : runTurn
			const out = await turn({
				userId: who.userId,
				role: who.role,
				message: body.message,
				conversationId: body.conversationId ? String(body.conversationId) : undefined,
				keyId: body.keyId ? String(body.keyId) : undefined,
				signal: ac.signal,
				emit,
				// A new chat has no id until its first message is saved. From then on the chat is taken.
				onConversation: (id) => {
					if (lock) return
					const key = `${who.userId}\u0000${id}`
					if (turning.has(key)) return
					turning.set(key, ac)
					lock = key
				},
			})
			if (timedOut) emit({event: 'error', data: {message: 'The assistant stopped answering, so this reply was cut off. Try again.', ...(out?.conversationId ? {conversationId: out.conversationId} : {})}})
		} finally {
			clearTimeout(idle)
			clearTimeout(total)
			clearInterval(ping)
			if (lock) turning.delete(lock)
			if (res.headersSent && !res.writableEnded && !res.destroyed) {
				try {
					res.end()
				} catch {
					/* client hung up */
				}
			}
		}
	}
	// A saved key (by id; its secret stays here) or what's typed into Add provider before saving.
	async function endpointFor(input, auth) {
		const who = actor(auth)
		if (input?.id) {
			const k = await keys.resolveForUser(who.userId, String(input.id))
			// Editing a saved key: check a newly typed key or address before it's saved. Only its owner may,
			// and a custom address follows the same owner-only rule as adding one. The check isn't recorded.
			const newKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : null
			const newUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : null
			if (!newKey && !newUrl) return {id: k.id, ownerUserId: k.ownerUserId, provider: k.provider, baseUrl: k.baseUrl, apiKey: k.apiKey, model: k.model, updatedAt: k.updatedAt}
			if (k.ownerUserId !== who.userId) throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			if (newKey && newKey.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
			let baseUrl = k.baseUrl
			if (newUrl && k.provider === 'openai-compatible') {
				if (who.role !== 'owner') throw new RpcError('FORBIDDEN', 'Only the server’s owner can change a custom endpoint')
				baseUrl = normalizeBaseUrl(newUrl)
				if (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 200) throw new RpcError('BAD_REQUEST', 'Enter the API base URL')
			}
			return {id: null, ownerUserId: k.ownerUserId, provider: k.provider, baseUrl, apiKey: newKey ?? k.apiKey, model: k.model}
		}
		const provider = String(input?.provider ?? '')
		let baseUrl = presetBaseUrl(provider)
		if (!baseUrl) {
			if (provider !== 'openai-compatible') throw new RpcError('BAD_REQUEST', 'Choose a provider')
			// Same rule as adding one: a typed address can point anywhere the server reaches.
			if (!customBasePermitted(who.role, input?.baseUrl)) throw new RpcError('FORBIDDEN', 'Only the server’s owner can add a custom endpoint')
			baseUrl = normalizeBaseUrl(input?.baseUrl)
			if (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 200) throw new RpcError('BAD_REQUEST', 'Enter the API base URL')
		}
		const apiKey = String(input?.apiKey ?? '').trim()
		if (apiKey.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
		return {id: null, provider, baseUrl, apiKey, model: String(input?.model ?? '')}
	}
	// Live check: is the endpoint there, does it take the key, which models does it serve.
	async function verify(input, {auth}) {
		const who = actor(auth)
		const ep = await endpointFor(input, auth)
		const result = await verifyKey({...ep, fetchImpl})
		const check = {ok: result.ok, status: result.status, message: result.message}
		if (ep.id) await keys.recordCheck(ep.id, check, {updatedAt: ep.updatedAt, apiKey: ep.apiKey, model: ep.model, baseUrl: ep.baseUrl})
		const own = !ep.ownerUserId || ep.ownerUserId === who.userId
		// The stored check can name the address for the person who added it. Someone else only hears that it failed.
		const shown = own || check.ok ? check : {ok: false, status: check.status, message: check.status === 'rejected' ? check.message : 'That provider did not answer.'}
		return {...shown, modelFound: own ? result.modelFound : null, models: own ? result.models : [], at: stamp()}
	}
	return {
		keys,
		conversations,
		chatgpt,
		runTurn,
		runTurnContinue,
		handleStream,
		procedures: {
			'assistant.keys': {kind: 'query', run: (_i, {auth}) => keys.listPublic(auth.userId)},
			'assistant.addKey': {kind: 'mutation', run: (input, {auth}) => keys.add(actor(auth), input)},
			'assistant.updateKey': {kind: 'mutation', run: (input, {auth}) => keys.update(actor(auth), input)},
			'assistant.reorderKeys': {kind: 'mutation', run: (input, {auth}) => keys.reorder(actor(auth), input?.ids)},
			'assistant.clearDefault': {kind: 'mutation', run: (_i, {auth}) => keys.clearDefault(actor(auth))},
			'assistant.useServerDefault': {kind: 'mutation', run: (input, {auth}) => keys.useServerDefault(actor(auth), input?.use !== false)},
			'assistant.verifyKey': {kind: 'mutation', run: verify},
			'assistant.removeKey': {
				kind: 'mutation',
				run: async (input, {auth}) => {
					const who = actor(auth)
					const id = String(input?.id ?? '')
					const k = await keys.getSecret(id)
					// Signing out of ChatGPT also revokes the sign-in at OpenAI. Best effort: the row still goes.
					if (k?.provider === 'chatgpt' && k.ownerUserId === who.userId) await chatgpt.revoke(id)
					return keys.remove(who, id)
				},
			},
			// Sign in with ChatGPT: start (the address to open), finish (the pasted address), and status
			// (when the browser is on this machine, omarchyd catches the callback itself).
			'assistant.chatgptStart': {kind: 'mutation', run: (input, {auth}) => chatgpt.start(actor(auth).userId, {keyId: input?.keyId})},
			'assistant.chatgptFinish': {kind: 'mutation', run: (input, {auth}) => chatgpt.finish(actor(auth).userId, input?.url)},
			'assistant.chatgptStatus': {kind: 'query', run: (_i, {auth}) => chatgpt.status(actor(auth).userId)},
			'assistant.models': {
				kind: 'query',
				run: async (input, {auth}) => {
					const who = actor(auth)
					const k = await keys.getSecret(String(input?.id ?? ''))
					if (!k || k.provider !== 'chatgpt' || k.ownerUserId !== who.userId) throw new RpcError('NOT_FOUND', 'That sign-in isn’t here')
					return chatgpt.models(k.id)
				},
			},
			'assistant.conversations': {kind: 'query', run: (_i, {auth}) => conversations.list(userIdOf(auth))},
			'assistant.getConversation': {kind: 'query', run: (input, {auth}) => conversations.get(userIdOf(auth), String(input?.id ?? ''))},
			'assistant.deleteConversation': {kind: 'mutation', run: (input, {auth}) => conversations.remove(userIdOf(auth), String(input?.id ?? ''))},
			// Stop the reply a chat is still writing. Only the person it belongs to can; nothing running is a no-op.
			'assistant.stop': {
				kind: 'mutation',
				run: (input, {auth}) => {
					const who = actor(auth)
					const ac = turning.get(`${who.userId}\u0000${String(input?.conversationId ?? '')}`)
					ac?.abort()
					return {stopped: Boolean(ac)}
				},
			},
			'assistant.approve': {kind: 'mutation', run: (input, ctx) => approve(input, ctx)},
			'assistant.reject': {kind: 'mutation', run: (input, ctx) => reject(input, ctx)},
		},
	}
}
