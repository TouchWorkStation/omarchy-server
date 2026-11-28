# NixOS machines: shared config mount + apply-on-boot

Repo: omarchy-server (Server) + MyOwnDataCenter/app-store (official images).  
Supersedes the host-push approach in `2026-11-28-nixos-lxc-design.md` and PR #1166’s primary apply path.

## Goal

Owners create NixOS **system containers (LXC)** and **virtual machines** the same way: paste `configuration.nix` at create time (and edit later), keep that config on a **live host share** mounted into the guest, and let a **guest service** detect changes, copy into `/etc/nixos`, run `nixos-rebuild`, and reboot into the new generation when needed. One **binary cache** setting is shared across all NixOS guests. Images and the guest module are **official** artifacts in `app-store`, not Modc-app-store, and not a new repository.

LXC (including NixOS) must be placeable on **this server or any connected physical machine** in the swarm. That placement work may ship in separate PRs from the NixOS share-apply core.

## Background

- LXC OS images today come from Incus `images:` (linuxcontainers.org). There is no MODC LXC image repo. NixOS container (and Incus VM) images are built by NixOS Hydra and republished there.
- MODC **libvirt** VMs use `app-store` `machines/catalog.json` (URLs to publisher disks/ISOs). That is not Podman apps; it is the official machine catalog in the same repo.
- Cloud-init is a poor fit as the source of truth for NixOS system config. Config-as-mounted-files + guest apply matches how owners think about “change config → restart → new system.”
- PR #1166 explored host `incus exec` + `nixos-rebuild`. That is not the product path going forward.

## Decisions

| Topic | Choice |
|---|---|
| Guest apply | MODC NixOS image includes compare/copy/`nixos-rebuild` service |
| Host delivery | Live directory share (virtiofs/9p for VMs; Incus disk bind for LXC) |
| Config files (v1) | `configuration.nix` only; share layout reserved for flakes later |
| Image home | Official `app-store` (`machines/nixos/` + catalog); not Modc-app-store; no new repo yet |
| LXC ↔ VM | Same guest module and host config UX; shared binary cache |
| LXC placement | This server **and** swarm physical machines (may be separate PRs) |
| #1166 | Rework to this model (drop host-push as primary apply) |

## Architecture

```text
┌──────────────── app-store ────────────────┐
│ machines/nixos/  Nix module + image builds │
│ machines/catalog.json  → VM qcow2 URL      │
│ (Incus container image published alongside)│
└───────────────────┬────────────────────────┘
                    │ fetch / import
┌───────────────────▼────────────────────────┐
│ Host (server or swarm computer)            │
│  nixos-configs/<id>/configuration.nix      │
│  mount ──► guest:/modc/nixos-config (ro)   │
│  shared nix-cache.json (substituter URL)   │
└───────────────────┬────────────────────────┘
                    │
┌───────────────────▼────────────────────────┐
│ Guest (MODC NixOS image)                   │
│  on boot / when share ready:               │
│  if mount ≠ /etc/nixos → copy → rebuild    │
│  reboot only when generation requires it   │
└────────────────────────────────────────────┘
```

### Guest module (app-store)

- Systemd unit (or NixOS activation hook) that:
  1. Waits for the config mount.
  2. Compares a stable hash of the mount tree to the last-applied hash (and/or to `/etc/nixos`).
  3. On difference: copy into `/etc/nixos`, run `nixos-rebuild switch` (with optional substituters from a drop-in on the share or from baked defaults).
  4. Reboot only when the new generation says a reboot is required (kernel etc.); otherwise leave the switched system running.
- First boot always differs → always applies once.
- Base image enables nesting-friendly settings for LXC builds, qemu-guest-agent for VMs, and the fixed mount path.
- Example `configuration.nix` in Server UI imports the right upstream modules (LXC container vs qemu VM)—the share holds the **owner** config; image ships a minimal default until the first apply.

### Host — config share (Server)

- Per NixOS instance directory under omarchyd data (server) or connector-managed data (remote host), e.g. `nixos-configs/<id>/configuration.nix`.
- Create UI (Machines / New container): when OS is NixOS, show configuration textarea + “Use example”; write file before/at first start; attach mount.
- Config tab: edit, Save (write share), Apply (save + restart guest), Export (download file). No host-side `nixos-rebuild`.
- Binary cache: one data-center setting (`enabled` + substituter URL). Written into the share (e.g. `cache.json` or `nix.conf` fragment) so every guest’s apply honors it. Same setting for LXC and VMs.

### Host — mounts

| Kind | Mechanism |
|---|---|
| VM (libvirt) | virtiofs preferred; 9p fallback if needed |
| LXC (Incus) | Disk device binding the host directory into the container at the fixed path |

Mount is read-only in the guest for v1 (host is source of truth).

### Images (app-store)

- Path: `machines/nixos/` — Nix expressions building:
  1. **libvirt qcow2** for Machines catalog.
  2. **Incus container image** (squashfs + metadata) for LXC.
- Both include the apply-on-boot module.
- `machines/catalog.json` lists the VM (kind `cloud` or a clear NixOS-specific kind if needed).
- LXC: Server documents import/alias from the published asset (and/or pulls it when creating a NixOS container). Not listed as a Podman app.
- CI in app-store builds and publishes release assets; Server only references URLs.

### Fleet LXC placement

Today LXC is server-local Incus only; VMs already take `hostId`. Product requirement: system containers are placeable on any connected physical machine that can run them.

That implies remote Incus (or equivalent) on swarm computers, create/list/power/config RPCs routed like remote VMs, and the config directory living **on the host that runs the guest**.

This is sequenced as its own PR track (see below), not a blocker for proving share-apply on the server.

## Create / maintain UX

- **Create VM:** catalog NixOS entry → host picker → resources → configuration field → create. Seed/account cloud-init only if still needed for a bootstrap user; system config is the share, not cloud-init YAML.
- **Create LXC:** NixOS in library (MODC image once available; stock `images:nixos` only as interim if import is not ready) → host picker (when fleet LXC exists) → same configuration field → create with mount + nesting as required.
- **Config tab** on NixOS guests (VM and LXC): same panel (shared React component).
- **Members:** see the machine; do not edit/apply NixOS config (owner-only), same as other Incus/VM mutations.

## Errors

- Non-NixOS + config supplied → refuse at create.
- Mount missing / service fails → guest keeps last generation; job/row shows plain-language failure (and last rebuild log lines when available).
- Rebuild failure → do not loop reboot; surface error; owner can fix share and Apply again.
- Cache URL invalid → refuse save; leave prior setting.
- Remote host without Incus / without image → refuse create with setup guidance.

## Out of scope (v1)

- Flakes UI (share layout may reserve paths).
- Full attic/Hydra on MODC; only optional substituter URL.
- App Store (Podman) on LXC.
- Building images inside the Server repo.
- Modc-app-store for these images.
- Members editing NixOS config.
- Shared `/nix/store` mounts across guests.

## Pull request sequence

1. **Design** (this doc) on Server.
2. **app-store:** Nix module + image build for VM qcow2 and Incus container; catalog entry; release assets.
3. **Server — shared NixOS host pieces:** config dir helpers, shared cache module/RPCs, shared Config UI, validation/example (extract from #1166 where useful).
4. **Server — NixOS VM:** catalog wiring, virtiofs/9p mount, create + Config tab, Apply = restart.
5. **Server — NixOS LXC (server host):** Incus disk bind mount, revise #1166 to share-apply (close or replace host-push apply).
6. **Server — fleet LXC placement:** remote Incus on swarm computers; host picker for containers; config dir on that host; then NixOS LXC on remote hosts uses the same share-apply path.

PRs 3–5 can overlap once images from 2 exist (or with a stub mount + stock image for bring-up). PR 6 can start after basic remote Incus exists, independent of flakes.

## Verification

- Create NixOS VM with example config → first boot applies → services from config present.
- Edit Config → Apply → guest restarts/rebuilds → change visible; system disk not recreated from scratch.
- Create NixOS LXC on server with same flow.
- Export downloads current `configuration.nix`.
- Cache on → rebuild log shows substituter use (or config fragment present).
- Non-NixOS create unchanged.
- After fleet LXC: create NixOS container on a connected computer; config share and apply work there.
- `tsc --noEmit -p web` and focused tests for share helpers / RPCs.

## Relation to #1165 / #1166

- **#1165** (no Apps on LXC): remains separate; still desired.
- **#1166** (NixOS LXC host-push): rework or follow-up to this design; do not merge host-push as the long-term apply path.
