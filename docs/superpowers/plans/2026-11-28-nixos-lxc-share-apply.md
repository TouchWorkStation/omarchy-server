# NixOS LXC share-apply (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NixOS system containers on this server use the same config-share + guest-apply model as VMs; remove host-push `nixos-rebuild` as the primary path (rework #1166).

**Architecture:** Host dir `{dataDir}/nixos-configs/<containerName>/` bound into the container at `/modc/nixos-config` via Incus disk device. Create writes `configuration.nix`; Apply = save + `containers.restart`. Prefer MODC Incus image from app-store; interim: stock `images:nixos` **only if** the apply module is present—otherwise require MODC image import alias `modc/nixos` documented in UI.

**Tech Stack:** Incus, Node, React, shared Plan 2 modules.

**Spec:** `docs/superpowers/specs/2026-11-28-nixos-share-apply-design.md`  
**Depends on:** `2026-11-28-nixos-share-host.md`; app-store container image (or documented import).

## Global Constraints

- Branch `feat/nixos-lxc-share` (close or replace #1166 / `feat/nixos-lxc` host-push).
- Tabs, no semicolons, single quotes. No version bump.
- Do **not** call `applyNixosConfig` via `incus exec` + `nixos-rebuild` as the product Apply path.
- Set `security.nesting=true` and `user.modc.nixos=true` for NixOS containers.
- Shared UI: `web/src/nixos/NixosConfigPanel.tsx`.

## File map

Modify:

- `omarchyd/containers.mjs` — create mount + write share; drop/replace host-push apply; get/set/apply = share + restart
- `omarchyd/nixos-lxc.mjs` — delete or reduce to thin re-exports of `nixos-config.mjs` (no exec rebuild)
- `server/app.mjs` — keep/adjust ALLOWED; prefer `containers.*` names for LXC-specific get/set/apply **or** reuse machines-style names scoped by container—**lock:** `containers.nixosConfig`, `containers.setNixosConfig`, `containers.applyNixosConfig` (apply = restart after write)
- `web/src/containers/Containers.tsx` — create field + Config tab using shared panel; remove host-push-only copy
- `test/nixos-lxc.test.mjs` — rewrite expectations around share write + disk device, not `nixos-rebuild` in run mock

---

### Task 1: Create binds config disk and writes share

**Files:**
- Modify: `omarchyd/containers.mjs`
- Modify: `test/nixos-lxc.test.mjs`

**Interfaces:**
- Consumes: `writeConfiguration`, `writeCacheFragment`, `readNixCache`, `validateNixosConfig`, `isNixosOs`, `NIXOS_GUEST_MOUNT`
- After `incus launch`, add device:

```js
await incus([
	'config', 'device', 'add', n, 'modc-nixos-config', 'disk',
	`source=${configDir(dataDir, n)}`,
	`path=${NIXOS_GUEST_MOUNT}`,
	'readonly=true',
])
```

Ensure dir exists before launch (even empty) so mount succeeds; write `configuration.nix` before first start when provided.

- [ ] **Step 1: Rewrite tests**

```js
test('create refuses nixosConfig on non-NixOS', async () => { /* same as before */ })

test('create NixOS writes share and adds disk device', async () => {
	const calls = []
	const dataDir = await mkdtemp(join(os.tmpdir(), 'lxc-nix-'))
	// mock run: list/image/query/launch/config device add
	const p = createContainers({run, dataDir}).procedures
	await p['containers.create'].run({name: 'nix1', image: 'nixos/24.11', nixosConfig: EXAMPLE})
	// wait for background launch
	assert.ok(calls.some((a) => a[0] === 'launch' && a.includes('security.nesting=true')))
	assert.ok(calls.some((a) => a[0] === 'config' && a.includes('device') && a.includes('modc-nixos-config')))
	const cfg = await readFile(join(dataDir, 'nixos-configs', 'nix1', 'configuration.nix'), 'utf8')
	assert.match(cfg, /stateVersion|systemPackages|config/)
	assert.ok(!calls.some((a) => a.includes('nixos-rebuild')))
})
```

- [ ] **Step 2: Implement create path; remove background `applyNixosConfig` job**

- [ ] **Step 3: Pass + commit**

```bash
node --test test/nixos-lxc.test.mjs
git commit -m "Mount NixOS config share into LXC on create"
```

---

### Task 2: get/set/apply via share + restart

**Files:**
- Modify: `omarchyd/containers.mjs`
- Delete or gut: `omarchyd/nixos-lxc.mjs` host-push `applyNixosConfig`

**Interfaces:**
- `containers.nixosConfig` → `readConfiguration(dataDir, name)` (host share is source of truth; optional: also show guest file later)
- `containers.setNixosConfig` → write share + cache fragment
- `containers.applyNixosConfig` → set if config provided, then `incus restart` (guest applies on boot)

- [ ] **Step 1: Tests** — set writes file; apply calls restart, never `nixos-rebuild` in `run` mock

- [ ] **Step 2: Implement + commit**

```bash
git commit -m "Apply NixOS LXC config by updating the share and restarting"
```

---

### Task 3: UI uses shared panel; drop host-push copy

**Files:**
- Modify: `web/src/containers/Containers.tsx`

**Interfaces:**
- Create: NixOS textarea → `nixosConfig` (keep)
- Config tab: `<NixosConfigPanel kind="lxc" … onApply={() => mutate apply} />`
- Remove any UI text that says host runs `nixos-rebuild` via Incus exec

- [ ] **Step 1: Wire panel**
- [ ] **Step 2: `npx tsc --noEmit -p web`**
- [ ] **Step 3: Commit**

```bash
git commit -m "Use shared NixOS Config panel for containers"
```

---

### Task 4: Close the loop on #1166

**Files:**
- PR description / `gh pr close` or force-push rework

- [ ] **Step 1:** If #1166 still open with host-push commits, replace branch with this plan’s commits or close #1166 with comment pointing at the share-apply PR.
- [ ] **Step 2:** Ensure design supersession note remains in `2026-11-28-nixos-share-apply-design.md`.

---

## Verification

- `node --test test/nixos-lxc.test.mjs`
- `npx tsc --noEmit -p web`
- Manual: MODC (or module-enabled) NixOS LXC + example config → restart applies; no host `nixos-rebuild` in logs.
- Cache fragment appears on share when `nix.setCache` enabled.
