export type StoreRepo = {url: string; meta: {id: string; name: string}; replaces?: string}
export type SuggestedStore = {url: string; name: string; blurb: string}

export const sameRepo = (a: string, b: string) =>
	a.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase() === b.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()

export function remainingSuggestedStores(suggested: SuggestedStore[], added: StoreRepo[]) {
	return suggested.filter((s) => !added.some((r) => sameRepo(r.url, s.url) || (r.replaces ? sameRepo(r.replaces, s.url) : false)))
}
