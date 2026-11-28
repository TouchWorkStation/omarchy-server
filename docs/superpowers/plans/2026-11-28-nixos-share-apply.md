# NixOS share-apply — plan index

> **For agentic workers:** Implement **one sub-plan at a time**. Do not start a later plan until its dependencies are mergeable. Each sub-plan has its own REQUIRED SUB-SKILL header.

**Spec:** `docs/superpowers/specs/2026-11-28-nixos-share-apply-design.md`

**Goal:** Unified NixOS create/maintain for VMs and LXC: live config share + guest apply-on-boot, official images in `app-store`, shared binary cache, then fleet LXC placement.

## Sub-plans (PR sequence)

| Order | Plan file | Repo | Depends on |
|---|---|---|---|
| 1 | `2026-11-28-nixos-images-app-store.md` | `MyOwnDataCenter/app-store` | Spec approved |
| 2 | `2026-11-28-nixos-share-host.md` | Server | Spec; can start before images land (tests use fixtures) |
| 3 | `2026-11-28-nixos-vm-share-apply.md` | Server | Plan 2; Plan 1 catalog URL (or stub URL for bring-up) |
| 4 | `2026-11-28-nixos-lxc-share-apply.md` | Server | Plan 2; Plan 1 container image (or stock `images:nixos` + module import interim) |
| 5 | `2026-11-28-fleet-lxc.md` | Server (+ connector) | Plan 4 for NixOS-on-remote; basic remote Incus can start in parallel |

## Related open work

- **#1165** — no Apps on LXC: keep separate; merge independently.
- **#1166** — host-push NixOS LXC: **do not merge as final**; supersede via Plan 4 (rework or close + replace).

## Global constants (all sub-plans)

- Guest mount path: `/modc/nixos-config` (read-only)
- Host config dir (server): `{dataDir}/nixos-configs/<id>/`
- Owner config file (v1): `configuration.nix`
- Optional cache fragment on share: `nix-cache.conf` (written by host from shared settings)
- Last-applied stamp in guest: `/var/lib/modc/nixos-config.sha256`
- Shared cache settings file (server): `{dataDir}/nix-cache.json` → `{enabled: boolean, substituter: string}`
- RPCs (shared): `nixos.configDir` helpers are internal; public: `nix.cache` / `nix.setCache` (or keep `containers.nixCache` aliases that call the same module until Plan 2 lands names—**Plan 2 locks the public names**)

## Execution

After Plan 1–2 exist on disk, prefer **subagent-driven-development** per task inside the active sub-plan. Ask which sub-plan to execute first if unclear (default: Plan 1 and Plan 2 in parallel in different worktrees/repos).
