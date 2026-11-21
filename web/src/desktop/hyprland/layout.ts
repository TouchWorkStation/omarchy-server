export type Axis = 'h' | 'v'
export type Dir = 'left' | 'right' | 'up' | 'down'
export type Rect = {x: number; y: number; w: number; h: number}
export type Node = {kind: 'leaf'; id: string} | {kind: 'split'; axis: Axis; ratio: number; a: Node; b: Node}

export const GAP = 8

export function rects(tree: Node | null, area: Rect, gap = GAP): Record<string, Rect> {
	const out: Record<string, Rect> = {}
	if (!tree) return out
	const walk = (n: Node, r: Rect) => {
		if (n.kind === 'leaf') {
			out[n.id] = r
			return
		}
		if (n.axis === 'h') {
			const avail = Math.max(0, r.w - gap)
			const aw = Math.round(avail * n.ratio)
			walk(n.a, {x: r.x, y: r.y, w: aw, h: r.h})
			walk(n.b, {x: r.x + aw + gap, y: r.y, w: r.w - aw - gap, h: r.h})
		} else {
			const avail = Math.max(0, r.h - gap)
			const ah = Math.round(avail * n.ratio)
			walk(n.a, {x: r.x, y: r.y, w: r.w, h: ah})
			walk(n.b, {x: r.x, y: r.y + ah + gap, w: r.w, h: r.h - ah - gap})
		}
	}
	walk(tree, area)
	return out
}

export function firstLeaf(tree: Node | null): string | null {
	if (!tree) return null
	return tree.kind === 'leaf' ? tree.id : firstLeaf(tree.a)
}

export function contains(tree: Node | null, id: string): boolean {
	if (!tree) return false
	return tree.kind === 'leaf' ? tree.id === id : contains(tree.a, id) || contains(tree.b, id)
}

export function collapse(tree: Node | null, skip: Iterable<string>): Node | null {
	const hidden = skip instanceof Set ? skip : new Set(skip)
	if (!tree || !hidden.size) return tree
	if (tree.kind === 'leaf') return hidden.has(tree.id) ? null : tree
	const a = collapse(tree.a, hidden)
	const b = collapse(tree.b, hidden)
	if (!a) return b
	if (!b) return a
	if (a === tree.a && b === tree.b) return tree
	return {...tree, a, b}
}

export function insert(tree: Node | null, focusedId: string | null, newId: string, area: Rect, gap = GAP, skip?: Iterable<string>): Node {
	if (!tree) return {kind: 'leaf', id: newId}
	const hidden = skip ? (skip instanceof Set ? skip : new Set(skip)) : new Set<string>()
	const shown = collapse(tree, hidden)
	if (!shown) {
		const axis: Axis = area.w >= area.h ? 'h' : 'v'
		return {kind: 'split', axis, ratio: 0.5, a: tree, b: {kind: 'leaf', id: newId}}
	}
	const target = focusedId && contains(shown, focusedId) ? focusedId : firstLeaf(shown)!
	const r = rects(shown, area, gap)[target]
	const axis: Axis = !r || r.w >= r.h ? 'h' : 'v'
	return replaceLeaf(tree, target, {
		kind: 'split',
		axis,
		ratio: 0.5,
		a: {kind: 'leaf', id: target},
		b: {kind: 'leaf', id: newId},
	})
}

export function remove(tree: Node | null, id: string): Node | null {
	if (!tree) return null
	if (tree.kind === 'leaf') return tree.id === id ? null : tree
	const a = remove(tree.a, id)
	const b = remove(tree.b, id)
	if (a === null) return b
	if (b === null) return a
	if (a === tree.a && b === tree.b) return tree
	return {...tree, a, b}
}

export function flipSplit(tree: Node | null, focusedId: string): Node | null {
	if (!tree) return null
	if (tree.kind === 'leaf') return tree
	if ((tree.a.kind === 'leaf' && tree.a.id === focusedId) || (tree.b.kind === 'leaf' && tree.b.id === focusedId)) {
		return {...tree, axis: tree.axis === 'h' ? 'v' : 'h'}
	}
	const a = flipSplit(tree.a, focusedId)!
	const b = flipSplit(tree.b, focusedId)!
	if (a === tree.a && b === tree.b) return tree
	return {...tree, a, b}
}

export function focusDir(tree: Node | null, focusedId: string, dir: Dir, area: Rect, gap = GAP, skip?: Iterable<string>): string {
	tree = skip ? collapse(tree, skip) : tree
	if (!tree) return focusedId
	const all = rects(tree, area, gap)
	const src = all[focusedId]
	if (!src) return focusedId
	const scx = src.x + src.w / 2
	const scy = src.y + src.h / 2
	let best: string | null = null
	let bestD = Infinity
	for (const [id, r] of Object.entries(all)) {
		if (id === focusedId) continue
		const dx = r.x + r.w / 2 - scx
		const dy = r.y + r.h / 2 - scy
		const along = dir === 'left' || dir === 'right' ? dx : dy
		const across = dir === 'left' || dir === 'right' ? dy : dx
		const positive = dir === 'right' || dir === 'down'
		if (positive ? along <= 0 : along >= 0) continue
		if (Math.abs(along) < Math.abs(across)) continue
		const d = dx * dx + dy * dy
		if (d < bestD) {
			bestD = d
			best = id
		}
	}
	return best ?? focusedId
}

export function swapIds(tree: Node | null, a: string, b: string): Node | null {
	if (!tree || a === b) return tree
	if (tree.kind === 'leaf') {
		if (tree.id === a) return {kind: 'leaf', id: b}
		if (tree.id === b) return {kind: 'leaf', id: a}
		return tree
	}
	return {...tree, a: swapIds(tree.a, a, b)!, b: swapIds(tree.b, a, b)!}
}

export function swapDir(tree: Node | null, focusedId: string, dir: Dir, area: Rect, gap = GAP, skip?: Iterable<string>): Node | null {
	const other = focusDir(tree, focusedId, dir, area, gap, skip)
	return swapIds(tree, focusedId, other)
}

export function rebuild(ids: string[], area: Rect, gap = GAP): Node | null {
	let tree: Node | null = null
	let last: string | null = null
	for (const id of ids) {
		tree = insert(tree, last, id, area, gap)
		last = id
	}
	return tree
}

export function isNode(n: unknown): n is Node {
	if (!n || typeof n !== 'object') return false
	const x = n as Record<string, unknown>
	if (x.kind === 'leaf') return typeof x.id === 'string'
	if (x.kind === 'split') return (x.axis === 'h' || x.axis === 'v') && typeof x.ratio === 'number' && isNode(x.a) && isNode(x.b)
	return false
}

export function leafIds(tree: Node | null): string[] {
	if (!tree) return []
	return tree.kind === 'leaf' ? [tree.id] : [...leafIds(tree.a), ...leafIds(tree.b)]
}

export function reconcile(tree: unknown, ids: string[], area: Rect, gap = GAP): Node | null {
	if (!ids.length) return null
	const valid = isNode(tree) ? tree : null
	if (!valid) return rebuild(ids, area, gap)
	const have = new Set(leafIds(valid))
	if (have.size === ids.length && ids.every((id) => have.has(id))) return valid
	let next: Node | null = valid
	for (const id of have) {
		if (!ids.includes(id)) next = remove(next, id)
	}
	let last = firstLeaf(next)
	for (const id of ids) {
		if (!contains(next, id)) {
			next = insert(next, last, id, area, gap)
			last = id
		}
	}
	return next
}

export function moveWorkspace(
	trees: Record<number, Node | null>,
	id: string,
	fromWs: number,
	toWs: number,
	opts: {floating?: boolean; targetFocusId?: string | null; area: Rect; gap?: number; hidden?: Iterable<string>},
): Record<number, Node | null> {
	if (fromWs === toWs) return trees
	const next: Record<number, Node | null> = {...trees}
	for (const k of Object.keys(next)) {
		const n = Number(k)
		next[n] = remove(next[n] ?? null, id)
	}
	if (!opts.floating) {
		const targetTree = next[toWs] ?? null
		next[toWs] = insert(targetTree, opts.targetFocusId ?? firstLeaf(targetTree), id, opts.area, opts.gap ?? GAP, opts.hidden)
	}
	return next
}

function replaceLeaf(tree: Node, id: string, next: Node): Node {
	if (tree.kind === 'leaf') return tree.id === id ? next : tree
	return {...tree, a: replaceLeaf(tree.a, id, next), b: replaceLeaf(tree.b, id, next)}
}
