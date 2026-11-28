import {useEffect, useState, type InputHTMLAttributes, type TextareaHTMLAttributes} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {Group, Switch, useToast} from '../ui'
import {NIXOS_EXAMPLE_LXC, NIXOS_EXAMPLE_VM} from './example'

type NixCache = {enabled: boolean; substituter: string}

const CACHE_URL = /^https?:\/\/[A-Za-z0-9._:~%/?#@[\]!$&'()*+,;=-]+$/

function cacheUrlValid(url: string) {
	const sub = url.trim()
	return sub.length > 0 && CACHE_URL.test(sub)
}

export type NixosConfigPanelProps = {
	id: string
	kind: 'vm' | 'lxc'
	busy: boolean
	running: boolean
	onApply: () => void
	readConfig: () => Promise<{config: string; present: boolean}>
	saveConfig: (config: string) => Promise<void>
}

function ConfigField({label, hint, ...props}: {label: string; hint?: string} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return (
		<div className="field">
			<label>{label}</label>
			<textarea {...props} />
			{hint ? <span className="hint">{hint}</span> : null}
		</div>
	)
}

function CacheUrlField({id, ...props}: {id: string} & InputHTMLAttributes<HTMLInputElement>) {
	return (
		<div className="field" style={{marginTop: 12}}>
			<label htmlFor={id}>Substituter URL</label>
			<input id={id} {...props} />
		</div>
	)
}

const plain = (e: Error) => e.message.replace(/^[A-Z_]+: /, '')

export function NixosConfigPanel({id, kind, busy, running, onApply, readConfig, saveConfig}: NixosConfigPanelProps) {
	const toast = useToast()
	const qc = useQueryClient()
	const [draft, setDraft] = useState('')
	const [dirty, setDirty] = useState(false)
	const [cacheUrl, setCacheUrl] = useState('')
	const [wantsCache, setWantsCache] = useState(false)

	const configQ = useQuery({
		queryKey: ['nixos.config', id, running],
		queryFn: () => readConfig(),
	})

	const cacheQ = useQuery({
		queryKey: ['nix.cache'],
		queryFn: () => query<NixCache>('nix.cache'),
	})

	useEffect(() => {
		if (configQ.data && !dirty) setDraft(configQ.data.config)
	}, [configQ.data, dirty])

	useEffect(() => {
		if (cacheQ.data) {
			setCacheUrl(cacheQ.data.substituter)
			setWantsCache(cacheQ.data.enabled)
		}
	}, [cacheQ.data])

	const setCache = useMutation({
		mutationFn: (input: NixCache) => mutate<NixCache>('nix.setCache', input),
		onSuccess: (data) => {
			qc.setQueryData(['nix.cache'], data)
			setCacheUrl(data.substituter)
			toast('Binary cache settings saved')
		},
		onError: (e: Error) => toast(plain(e), true),
	})

	const save = useMutation({
		mutationFn: () => saveConfig(draft),
		onSuccess: () => {
			setDirty(false)
			void qc.invalidateQueries({queryKey: ['nixos.config', id]})
			toast('Configuration saved')
		},
		onError: (e: Error) => toast(plain(e), true),
	})

	const apply = useMutation({
		mutationFn: async () => {
			await saveConfig(draft)
			onApply()
		},
		onSuccess: () => {
			setDirty(false)
			void qc.invalidateQueries({queryKey: ['nixos.config', id]})
			toast('Configuration saved')
		},
		onError: (e: Error) => toast(plain(e), true),
	})

	const example = kind === 'vm' ? NIXOS_EXAMPLE_VM : NIXOS_EXAMPLE_LXC
	const actionBusy = busy || save.isPending || apply.isPending

	const exportFile = () => {
		const blob = new Blob([draft], {type: 'text/plain;charset=utf-8'})
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = 'configuration.nix'
		a.click()
		URL.revokeObjectURL(url)
	}

	const cacheBusy = setCache.isPending

	const onCacheToggle = (enabled: boolean) => {
		setWantsCache(enabled)
		if (!enabled) {
			setCache.mutate({enabled: false, substituter: cacheUrl})
			return
		}
		if (cacheUrlValid(cacheUrl)) setCache.mutate({enabled: true, substituter: cacheUrl.trim()})
	}

	const onCacheUrlBlur = () => {
		if (wantsCache && cacheUrlValid(cacheUrl)) setCache.mutate({enabled: true, substituter: cacheUrl.trim()})
	}

	return (
		<>
			<Group
				title="NixOS configuration"
				footer="Lives on this server’s share and is mounted into the guest. The guest applies it on boot—nothing here runs nixos-rebuild."
			>
				{!running ? (
					<p className="muted" style={{fontSize: 13.5, margin: '0 6px 12px'}}>
						Start this {kind === 'vm' ? 'machine' : 'container'} when you want it to pick up changes. You can still edit the share anytime; Apply may wait until it is running.
					</p>
				) : null}
				<ConfigField
					label="configuration.nix"
					className="mono"
					rows={16}
					value={draft}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					disabled={actionBusy}
					onChange={(e) => {
						setDraft(e.target.value)
						setDirty(true)
					}}
				/>
				<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12}}>
					<button type="button" className="btn small" disabled={actionBusy} onClick={() => (setDraft(example), setDirty(true))}>
						Use example
					</button>
					<button type="button" className="btn small" disabled={actionBusy || !dirty} onClick={() => save.mutate()}>
						{save.isPending ? <span className="spinner" /> : null}
						Save
					</button>
					<button type="button" className="btn small primary" disabled={actionBusy} onClick={() => apply.mutate()}>
						{apply.isPending ? <span className="spinner" /> : null}
						Apply
					</button>
					<button type="button" className="btn small" disabled={!draft.trim()} onClick={exportFile}>
						<Icon name="download" size={14} /> Export
					</button>
				</div>
				{configQ.isError ? (
					<p className="muted" style={{fontSize: 13, marginTop: 10}} role="alert">
						<Icon name="alert" size={16} /> Couldn’t load configuration: {plain(configQ.error as Error)}
					</p>
				) : null}
			</Group>
			<Group title="Binary cache" footer="Optional HTTP substituter shared by every NixOS guest. When enabled, a fragment is written into each config share.">
				<Switch
					label="Use a binary cache"
					on={wantsCache}
					disabled={cacheQ.isLoading || cacheBusy}
					onChange={onCacheToggle}
				/>
				{wantsCache ? (
					<CacheUrlField
						id={`nix-cache-url-${id}`}
						value={cacheUrl}
						placeholder="https://cache.example/nix-store"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						disabled={cacheBusy}
						onChange={(e) => setCacheUrl(e.target.value)}
						onBlur={onCacheUrlBlur}
					/>
				) : null}
			</Group>
		</>
	)
}