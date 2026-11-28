# NixOS VM share-apply (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and maintain NixOS VMs with a live config share mounted at `/modc/nixos-config`; Apply writes the share and restarts the guest (guest module rebuilds).

**Architecture:** Detect NixOS catalog images (`familyId === 'nixos'` or `nixos: true`). On create, write `configuration.nix` under `{dataDir}/nixos-configs/<machineId>/`, attach a 9p (or virtiofs) filesystem to the domain, sync cache fragment. Config tab uses shared `NixosConfigPanel`; Apply = save + `machines.restart`.

**Tech Stack:** libvirt XML via existing `machines.mjs` define path, Node, React.

**Spec:** `docs/superpowers/specs/2026-11-28-nixos-share-apply-design.md`  
**Depends on:** Plan `2026-11-28-nixos-share-host.md`; catalog entry from app-store plan (or temporary stub URL).

## Global Constraints

- Branch `feat/nixos-vm-share` from main (after host plan merged or stacked).
- Tabs, no semicolons, single quotes. Sentence-case commits, no version bump.
- Do not host-push `nixos-rebuild` into the VM.
- Prefer 9p tag `modc-nixos-config` matching the guest module; virtiofs if the define path already supports it—pick one and document in code comment.
- Owner-only config mutations.

## File map

Modify:

- `omarchyd/machines.mjs` — create accepts `nixosConfig`; attach filesystem; helpers get/set config; restart-on-apply
- `omarchyd/server.mjs` — pass `dataDir` into machines if not already
- `server/app.mjs` — ALLOWED for `machines.nixosConfig`, `machines.setNixosConfig`, `machines.applyNixosConfig`
- `web/src/CreateMachine.tsx` — NixOS configuration field when selected image is NixOS
- `web/src/screens/Machine.tsx` or VM detail component that hosts tabs — Config tab
- Bundled `omarchyd/machine-catalog.json` — optional stub NixOS entry for offline tests

Create:

- `test/nixos-vm-config.test.mjs` — create refuses non-nixos config; write share on create (mocked define)

---

### Task 1: Create writes share and records nixos flag

**Files:**
- Modify: `omarchyd/machines.mjs`
- Create: `test/nixos-vm-config.test.mjs`

**Interfaces:**
- Consumes: `writeConfiguration`, `writeCacheFragment`, `readNixCache`, `validateNixosConfig`, `isNixosOs` from Plan 2
- `machines.create` input gains optional `nixosConfig: string`
- Machine record gains `nixos: true` when catalog image is NixOS

- [ ] **Step 1: Failing test** — mock catalog image with `familyId: 'nixos'`; assert `writeConfiguration` path receives create body; assert non-nixos image + nixosConfig throws `RpcError` / BAD_REQUEST.

- [ ] **Step 2: Implement** in `create` / `createOnHost` after id allocated:

```js
const nixos = img.nixos === true || img.familyId === 'nixos'
if (input.nixosConfig && !nixos) throw new RpcError('BAD_REQUEST', 'NixOS configuration is only for NixOS images.')
if (nixos && input.nixosConfig) {
	const checked = validateNixosConfig(input.nixosConfig)
	if (!checked.ok) throw new RpcError('BAD_REQUEST', checked.error)
	if (checked.config.trim()) {
		await writeConfiguration(dataDir, id, checked.config)
		const cache = await readNixCache(dataDir)
		await writeCacheFragment(dataDir, id, cache)
	}
}
m.nixos = nixos
```

- [ ] **Step 3: Tests pass + commit**

```bash
node --test test/nixos-vm-config.test.mjs
git add omarchyd/machines.mjs test/nixos-vm-config.test.mjs
git commit -m "Write NixOS config share when creating a VM"
```

---

### Task 2: Attach 9p filesystem on define

**Files:**
- Modify: `omarchyd/machines.mjs` (layout / define XML builder)

**Interfaces:**
- When `m.nixos`, domain XML includes:

```xml
<filesystem type='mount' accessmode='passthrough'>
  <source dir='/absolute/host/nixos-configs/<id>'/>
  <target dir='modc-nixos-config'/>
  <readonly/>
</filesystem>
```

For qemu 9p, also ensure `<memoryBacking>` / driver as required by the host’s libvirt—follow existing patterns in repo; if none, use `driver type='virtio-9p'` source.

- [ ] **Step 1: Unit test** that XML/layout helper includes source dir = `configDir(dataDir, id)` and target `modc-nixos-config`.

- [ ] **Step 2: Implement + commit**

```bash
git commit -m "Mount NixOS config share into the VM"
```

---

### Task 3: RPCs get/set/apply

**Files:**
- Modify: `omarchyd/machines.mjs`, `server/app.mjs`

**Interfaces:**
- `machines.nixosConfig` `{id}` → `readConfiguration`
- `machines.setNixosConfig` `{id, config}` → validate + write + refresh cache fragment
- `machines.applyNixosConfig` `{id, config?}` → set if provided, then restart guest (reuse `machines.restart` / power path)

- [ ] **Step 1: Tests** for set writes file; apply invokes restart mock.

- [ ] **Step 2: Implement + ALLOWED + commit**

```bash
git commit -m "Add NixOS config RPCs for virtual machines"
```

---

### Task 4: Create + detail UI

**Files:**
- Modify: `web/src/CreateMachine.tsx`
- Modify: VM detail / `Machine` tabs component (locate via `MachineTabs` usage for guests)
- Use: `web/src/nixos/NixosConfigPanel.tsx`

**Interfaces:**
- Create: if `image.familyId === 'nixos' || image.nixos`, show textarea + Use example (`NIXOS_EXAMPLE_VM`); pass `nixosConfig` into `machines.create`.
- Detail: Config tab when `machine.nixos`; `onApply` → `machines.applyNixosConfig`.

- [ ] **Step 1: Wire CreateMachine**
- [ ] **Step 2: Wire Config tab**
- [ ] **Step 3: `npx tsc --noEmit -p web`**
- [ ] **Step 4: Commit**

```bash
git commit -m "Add NixOS configuration UI for virtual machines"
```

---

## Verification

- `node --test test/nixos-vm-config.test.mjs`
- `npx tsc --noEmit -p web`
- Manual (when image exists): create NixOS VM with example → boot applies → edit Config → Apply → change lands without recreating the disk.
