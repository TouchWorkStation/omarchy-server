// Load desktop wallpapers with cancellation so slow images never overwrite newer selections.
export type ImageLike = {
	onload: ((ev: never) => unknown) | null
	onerror: ((ev: never) => unknown) | null
	src: string
}

export function loadWallpaper(
	url: string,
	{
		fallback,
		onLoad,
		createImage = () => new Image(),
	}: {
		fallback?: string
		onLoad: (loadedUrl: string) => void
		createImage?: () => ImageLike
	},
): () => void {
	let cancelled = false
	let active: ImageLike | null = null

	const clearHandlers = (img: ImageLike | null) => {
		if (!img) return
		img.onload = null
		img.onerror = null
	}

	const show = (u: string, nextFallback?: string) => {
		if (cancelled) return
		clearHandlers(active)
		const img = createImage()
		active = img
		img.onload = () => {
			if (cancelled || active !== img) return
			onLoad(u)
		}
		img.onerror = () => {
			if (cancelled || active !== img) return
			if (nextFallback) show(nextFallback)
		}
		img.src = u
	}

	show(url, fallback)

	return () => {
		cancelled = true
		clearHandlers(active)
		active = null
	}
}
