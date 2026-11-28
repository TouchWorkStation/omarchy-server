# NixOS shared host pieces (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared Server helpers for NixOS config directories, validation/example text, binary-cache settings, and a reusable Config UI panel—used by both VM and LXC plans.

**Architecture:** Pure host-side modules under `omarchyd/` with no Incus/libvirt calls. RPCs for cache are top-level `nix.*`. UI component lives under `web/src/nixos/`.

**Tech Stack:** Node ESM, React/TypeScript, `node --test`, `tsc --noEmit -p web`.

**Spec:** `docs/superpowers/specs/2026-11-28-nixos-share-apply-design.md`  
**Index:** `docs/superpowers/plans/2026-11-28-nixos-share-apply.md`

## Global Constraints

- Worktree on branch `feat/nixos-share-host` from current `main` (or continue `feat/nixos-share-apply` if design-only commits are already there—prefer a clean feature branch from main + cherry-pick design if needed).
- Tabs, no semicolons, single quotes. Commit subjects sentence case, no `feat:` prefix, no trailing period.
- Do not bump version / changelog / installer revision.
- Do **not** call `nixos-rebuild` or `incus exec` for apply in this plan.
- TDD for Node helpers. Focused tests only.
- Public RPC names locked here: `nix.cache` (query), `nix.setCache` (mutation).

## File map

Create:

- `omarchyd/nixos-config.mjs` — validate, example, path helpers, read/write share dir, write cache fragment onto share
- `omarchyd/nix-cache.mjs` — read/write `{dataDir}/nix-cache.json`
- `test/nixos-config.test.mjs`
- `test/nix-cache.test.mjs`
- `web/src/nixos/NixosConfigPanel.tsx` — shared Config UI
- `web/src/nixos/example.ts` — `NIXOS_EXAMPLE_VM`, `NIXOS_EXAMPLE_LXC`, `isNixosOs`

Modify:

- `omarchyd/server.mjs` — wire `nix.cache` / `nix.setCache` with `dataDir`
- `server/app.mjs` — ALLOWED + SLOW for `nix.setCache`

---

### Task 1: Validation and path helpers

**Files:**
- Create: `omarchyd/nixos-config.mjs`
- Create: `test/nixos-config.test.mjs`

**Interfaces:**
- Produces:
  - `NIXOS_CONFIG_MAX = 512 * 1024`
  - `NIXOS_GUEST_MOUNT = '/modc/nixos-config'`
  - `isNixosOs(os: string): boolean`
  - `validateNixosConfig(text: string): {ok: true, config: string} | {ok: false, error: string}`
  - `configDir(dataDir: string, id: string): string` → `join(dataDir, 'nixos-configs', id)`
  - `async ensureConfigDir(dataDir, id): Promise<string>`
  - `async writeConfiguration(dataDir, id, config: string): Promise<{path: string}>`
  - `async readConfiguration(dataDir, id): Promise<{config: string, present: boolean}>`
  - `async writeCacheFragment(dataDir, id, {enabled, substituter}): Promise<void>` — writes `nix-cache.conf` into the share when enabled+URL, else removes file

- [ ] **Step 1: Write failing tests**

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, readFile, access} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {
	isNixosOs,
	validateNixosConfig,
	writeConfiguration,
	readConfiguration,
	writeCacheFragment,
	configDir,
} from '../omarchyd/nixos-config.mjs'

test('isNixosOs', () => {
	assert.equal(isNixosOs('nixos'), true)
	assert.equal(isNixosOs('NixOS'), true)
	assert.equal(isNixosOs('debian'), false)
})

test('validate rejects null bytes and junk', () => {
	assert.equal(validateNixosConfig('').ok, true)
	assert.equal(validateNixosConfig('not nix').ok, false)
	assert.equal(validateNixosConfig('x\0').ok, false)
})

test('write and read configuration.nix on the share', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nixos-cfg-'))
	const body = `{ config, pkgs, ... }:\n{\n  system.stateVersion = "24.11";\n}\n`
	assert.equal(validateNixosConfig(body).ok, true)
	await writeConfiguration(dataDir, 'vm1', body)
	const got = await readConfiguration(dataDir, 'vm1')
	assert.equal(got.present, true)
	assert.match(got.config, /stateVersion/)
	assert.equal(configDir(dataDir, 'vm1'), join(dataDir, 'nixos-configs', 'vm1'))
})

test('cache fragment written only when enabled', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nixos-cfg-'))
	await writeConfiguration(dataDir, 'vm1', `{ config, pkgs, ... }:\n{ system.stateVersion = "24.11"; }\n`)
	await writeCacheFragment(dataDir, 'vm1', {enabled: true, substituter: 'http://10.0.0.1:5000'})
	const conf = await readFile(join(dataDir, 'nixos-configs', 'vm1', 'nix-cache.conf'), 'utf8')
	assert.match(conf, /extra-substituters = http:\/\/10\.0\.0\.1:5000/)
	await writeCacheFragment(dataDir, 'vm1', {enabled: false, substituter: ''})
	await assert.rejects(() => access(join(dataDir, 'nixos-configs', 'vm1', 'nix-cache.conf')))
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test test/nixos-config.test.mjs
```

Expected: FAIL (module missing)

- [ ] **Step 3: Implement `omarchyd/nixos-config.mjs`**

```js
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'

export const NIXOS_CONFIG_MAX = 512 * 1024
export const NIXOS_GUEST_MOUNT = '/modc/nixos-config'

export function isNixosOs(os = '') {
	return /^nixos$/i.test(String(os).trim())
}

export function validateNixosConfig(text) {
	const config = String(text ?? '')
	if (!config.trim()) return {ok: true, config: ''}
	if (config.length > NIXOS_CONFIG_MAX) return {ok: false, error: 'That configuration is too large (512 KB max).'}
	if (config.includes('\0')) return {ok: false, error: 'The configuration can’t contain null bytes.'}
	if (!/\{\s*config\s*,\s*pkgs\s*,/.test(config) && !config.includes('system.stateVersion') && !config.includes('environment.systemPackages')) {
		return {ok: false, error: 'That doesn’t look like a NixOS configuration.nix.'}
	}
	return {ok: true, config}
}

export function configDir(dataDir, id) {
	return join(String(dataDir), 'nixos-configs', String(id))
}

export async function ensureConfigDir(dataDir, id) {
	const dir = configDir(dataDir, id)
	await mkdir(dir, {recursive: true})
	return dir
}

export async function writeConfiguration(dataDir, id, config) {
	const checked = validateNixosConfig(config)
	if (!checked.ok) throw new Error(checked.error)
	if (!checked.config.trim()) throw new Error('Paste a NixOS configuration first.')
	const dir = await ensureConfigDir(dataDir, id)
	const body = checked.config.endsWith('\n') ? checked.config : `${checked.config}\n`
	await writeFile(join(dir, 'configuration.nix'), body)
	return {path: join(dir, 'configuration.nix')}
}

export async function readConfiguration(dataDir, id) {
	try {
		const config = await readFile(join(configDir(dataDir, id), 'configuration.nix'), 'utf8')
		return {config, present: true}
	} catch {
		return {config: '', present: false}
	}
}

export async function writeCacheFragment(dataDir, id, {enabled, substituter}) {
	const dir = await ensureConfigDir(dataDir, id)
	const path = join(dir, 'nix-cache.conf')
	const sub = String(substituter ?? '').trim()
	if (!enabled || !sub) {
		await rm(path, {force: true})
		return
	}
	if (!/^https?:\/\/[A-Za-z0-9._:~%/?#@[\]!$&'()*+,;=-]+$/.test(sub)) throw new Error('Use an http(s) URL for the binary cache.')
	await writeFile(path, `extra-substituters = ${sub}\n`)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test test/nixos-config.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add omarchyd/nixos-config.mjs test/nixos-config.test.mjs
git commit -m "Add NixOS config share helpers"
```

---

### Task 2: Shared binary cache settings

**Files:**
- Create: `omarchyd/nix-cache.mjs`
- Create: `test/nix-cache.test.mjs`
- Modify: `omarchyd/server.mjs`
- Modify: `server/app.mjs`

**Interfaces:**
- Produces: `readNixCache(dataDir)`, `writeNixCache(dataDir, {enabled, substituter})`
- RPCs: `nix.cache` query → `{enabled, substituter}`; `nix.setCache` mutation → same

- [ ] **Step 1: Failing test**

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {readNixCache, writeNixCache} from '../omarchyd/nix-cache.mjs'

test('nix cache defaults off and persists', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nix-cache-'))
	assert.deepEqual(await readNixCache(dataDir), {enabled: false, substituter: ''})
	await writeNixCache(dataDir, {enabled: true, substituter: 'http://10.0.0.1:5000'})
	assert.deepEqual(await readNixCache(dataDir), {enabled: true, substituter: 'http://10.0.0.1:5000'})
})
```

- [ ] **Step 2: Implement `nix-cache.mjs`** (JSON file `{dataDir}/nix-cache.json`; validate URL when enabled)

- [ ] **Step 3: Wire procedures** in `createServer` / procedure table:

```js
'nix.cache': {kind: 'query', run: () => readNixCache(dataDir)},
'nix.setCache': {kind: 'mutation', run: (input) => writeNixCache(dataDir, input ?? {})},
```

Owner-only like other server settings. Register in `server/app.mjs` ALLOWED; add `nix.setCache` to SLOW if disk I/O is grouped there (optional).

- [ ] **Step 4: Tests pass + commit**

```bash
node --test test/nix-cache.test.mjs
git add omarchyd/nix-cache.mjs test/nix-cache.test.mjs omarchyd/server.mjs server/app.mjs
git commit -m "Add shared Nix binary cache settings"
```

---

### Task 3: Shared Config UI panel

**Files:**
- Create: `web/src/nixos/example.ts`
- Create: `web/src/nixos/NixosConfigPanel.tsx`

**Interfaces:**
- Props: `{id: string; kind: 'vm' | 'lxc'; busy: boolean; running: boolean; onApply: () => void; readConfig: () => Promise<{config: string; present: boolean}>; saveConfig: (config: string) => Promise<void>}`
- Uses `query('nix.cache')` / `mutate('nix.setCache', …)` for Binary cache group
- Export downloads `configuration.nix` via Blob
- `onApply` is provided by parent (VM restart vs LXC restart)—panel only saves then calls `onApply`

- [ ] **Step 1: Add `example.ts`** with short VM and LXC examples (VM: qemu guest modules comment; LXC: `lxc-container.nix` import) and `isNixosOs`.

- [ ] **Step 2: Implement `NixosConfigPanel`** mirroring the Config + Binary cache groups from the superseded Containers draft: textarea, Use example, Save, Apply, Export, cache switch + URL.

- [ ] **Step 3: `npx tsc --noEmit -p web`**

Expected: PASS (panel unused until Plans 3–4)

- [ ] **Step 4: Commit**

```bash
git add web/src/nixos
git commit -m "Add shared NixOS Config panel"
```

---

## Verification

- `node --test test/nixos-config.test.mjs test/nix-cache.test.mjs`
- `npx tsc --noEmit -p web`
- No guest rebuilds in this plan.
