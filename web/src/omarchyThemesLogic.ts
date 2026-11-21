// Pure helpers for OmarchyThemes polling, busy state, and action completion.
type JobLike = {state: string; error?: string}
type ThemeListLike = {installed?: ReadonlyArray<{job?: JobLike}>; more?: ReadonlyArray<{job?: JobLike}>} | undefined

export function waitsForThemeSwitch(path: string): boolean {
	return path !== 'omarchy.removeTheme'
}

export function shouldPollThemes(pending: string | null, data: ThemeListLike): boolean {
	return Boolean(
		pending ||
			data?.installed?.some((t) => t.job && t.job.state !== 'error') ||
			data?.more?.some((t) => t.job && t.job.state !== 'error'),
	)
}

export function isMoreThemeBusy(theme: {slug: string; job?: JobLike}, pending: string | null): boolean {
	return Boolean((theme.job && theme.job.state !== 'error') || pending === theme.slug)
}

export async function runThemeAction({
	path,
	slug,
	done,
	mutate,
	invalidate,
	setPending,
	toast,
}: {
	path: string
	slug: string
	done?: string
	mutate: (path: string, input: {slug: string}) => Promise<unknown>
	invalidate: () => Promise<unknown>
	setPending: (updater: string | null | ((cur: string | null) => string | null)) => void
	toast: (message: string, error?: boolean) => void
}): Promise<void> {
	setPending(slug)
	try {
		await mutate(path, {slug})
		if (done) toast(done)
	} catch (e) {
		setPending((cur) => (cur === slug ? null : cur))
		toast((e as Error).message, true)
		return
	}
	try {
		await invalidate()
	} catch {
		// Keep the success toast; the list will refresh on focus or next open.
	} finally {
		if (!waitsForThemeSwitch(path)) {
			setPending((cur) => (cur === slug ? null : cur))
		}
	}
}
