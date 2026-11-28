# MODC NixOS images (app-store) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship official MODC NixOS guest images (libvirt qcow2 + Incus container) that mount `/modc/nixos-config`, apply `configuration.nix` when it changes, and list the VM in `machines/catalog.json`.

**Architecture:** A shared NixOS module implements compare → copy → `nixos-rebuild switch` → conditional reboot. VM and container image flakes import that module with the right virtualisation base. CI builds release assets; catalog points at release URLs with sha256.

**Tech Stack:** Nix flakes, NixOS modules, GitHub Actions, `machines/catalog.json`.

**Spec:** `docs/superpowers/specs/2026-11-28-nixos-share-apply-design.md` (in Server).  
**Index:** `docs/superpowers/plans/2026-11-28-nixos-share-apply.md`.

## Global Constraints

- Work in a clone of `https://github.com/MyOwnDataCenter/app-store` on branch `feat/nixos-images` (create via normal clone; not Server worktree).
- Do **not** put these under Modc-app-store or as Podman `omarchy-app.yml` apps.
- Guest mount path is exactly `/modc/nixos-config` (read-only).
- v1 applies only `configuration.nix` from that mount (ignore other files except optional `nix-cache.conf`).
- Do not bump unrelated catalog image versions.
- Prefer `nixos-rebuild switch`; reboot only when `/run/current-system/specialisation` or `booted` vs `current` system indicates reboot needed—use `system.activationScripts` / check `builtin.compareVersions` pattern: after switch, if `/run/booted-system` ≠ `/run/current-system` for kernel path, reboot once.

## File map

Create:

- `machines/nixos/README.md` — what these images are, mount contract, how Server uses them
- `machines/nixos/module/modc-nixos-config.nix` — apply-on-boot module
- `machines/nixos/module/default.nix` — re-export
- `machines/nixos/vm/flake.nix` — libvirt/qcow2 image
- `machines/nixos/container/flake.nix` — Incus container image + metadata
- `machines/nixos/.github-workflows-snippet.md` or `.github/workflows/nixos-images.yml` — build + release assets
- `machines/nixos/smoke/test-apply.sh` — optional local smoke against a throwaway VM

Modify:

- `machines/catalog.json` — add NixOS family entries once release URLs exist
- Root README only if app-store already documents `machines/`

---

### Task 1: Guest apply module

**Files:**
- Create: `machines/nixos/module/modc-nixos-config.nix`
- Create: `machines/nixos/module/default.nix`
- Create: `machines/nixos/README.md`

**Interfaces:**
- Consumes: NixOS module system; mount at `/modc/nixos-config`
- Produces: module enabling systemd oneshot/path unit `modc-nixos-config-apply.service` that owners’ images import

- [ ] **Step 1: Write the module**

`machines/nixos/module/modc-nixos-config.nix`:

```nix
{ lib, pkgs, ... }:
{
  # Fixed mount point — host bind/virtiofs target.
  fileSystems."/modc/nixos-config" = {
    device = "modc-nixos-config";
    fsType = "9p"; # VM default; container images override via extra module
    options = [ "ro" "trans=virtio" "version=9p2000.L" "x-systemd.after=dev-disk-by\\x2dlabel.device" "nofail" "x-systemd.device-timeout=30" ];
  };

  systemd.services.modc-nixos-config-apply = {
    description = "Apply MODC NixOS configuration from mounted share";
    wantedBy = [ "multi-user.target" ];
    after = [ "modc-nixos-config.mount" "network-online.target" ];
    wants = [ "network-online.target" ];
    path = [ pkgs.coreutils pkgs.nixos-rebuild pkgs.nix pkgs.rsync pkgs.util-linux ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      set -eu
      MOUNT=/modc/nixos-config
      STAMP=/var/lib/modc/nixos-config.sha256
      DEST=/etc/nixos
      mkdir -p /var/lib/modc "$DEST"
      # Wait up to ~2 minutes for the share (slow virtiofs/9p).
      for i in $(seq 1 60); do
        if [ -d "$MOUNT" ] && [ -f "$MOUNT/configuration.nix" ]; then break; fi
        sleep 2
      done
      if [ ! -f "$MOUNT/configuration.nix" ]; then
        echo "modc-nixos-config: no configuration.nix on mount; skipping"
        exit 0
      fi
      NEW=$(find "$MOUNT" -type f \( -name 'configuration.nix' -o -name 'nix-cache.conf' \) -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
      OLD=""
      [ -f "$STAMP" ] && OLD=$(cat "$STAMP")
      if [ "$NEW" = "$OLD" ]; then
        echo "modc-nixos-config: unchanged"
        exit 0
      fi
      cp -a "$MOUNT/configuration.nix" "$DEST/configuration.nix"
      if [ -f "$MOUNT/nix-cache.conf" ]; then
        mkdir -p /etc/nix/nix.conf.d
        cp -a "$MOUNT/nix-cache.conf" /etc/nix/nix.conf.d/99-modc-cache.conf
      fi
      if ! nixos-rebuild switch; then
        echo "modc-nixos-config: nixos-rebuild failed" >&2
        exit 1
      fi
      echo "$NEW" > "$STAMP"
      if [ "$(readlink -f /run/booted-system)" != "$(readlink -f /run/current-system)" ]; then
        systemctl reboot
      fi
    '';
  };
}
```

`machines/nixos/module/default.nix`:

```nix
{ imports = [ ./modc-nixos-config.nix ]; }
```

`machines/nixos/README.md`: document mount path, `configuration.nix`, optional `nix-cache.conf`, that Server owns the host directory.

- [ ] **Step 2: Commit**

```bash
git add machines/nixos/module machines/nixos/README.md
git commit -m "Add MODC NixOS config-from-share guest module"
```

---

### Task 2: VM qcow2 flake

**Files:**
- Create: `machines/nixos/vm/flake.nix`

**Interfaces:**
- Consumes: `../module`
- Produces: `nixosConfigurations.modc-vm` with `config.system.build.qcow` or `qemuImage` (use current nixpkgs `make-disk-image` / `qemu-vm` pattern for a cloud-style qcow2 with virtio, qemu-guest-agent, grow partition)

- [ ] **Step 1: Write flake**

```nix
{
  description = "MODC NixOS libvirt image with config share apply";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  outputs = { self, nixpkgs }: {
    nixosConfigurations.modc-vm = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        "${nixpkgs}/nixos/modules/profiles/qemu-guest.nix"
        ../module
        ({ pkgs, ... }: {
          networking.hostName = "nixos";
          services.qemuGuest.enable = true;
          # Prefer virtiofs when Server adds it; 9p tag must match libvirt.
          fileSystems."/modc/nixos-config" = {
            device = "modc-nixos-config";
            fsType = "9p";
            options = [ "ro" "trans=virtio" "version=9p2000.L" "nofail" ];
          };
          system.stateVersion = "24.11";
        })
      ];
    };
  };
}
```

Extend with a `packages.qcow2` derivation using nixpkgs `make-disk-image.nix` (copy the pattern from nixpkgs `nixos/lib/make-disk-image.nix` consumers—keep format qcow2, disk size ≥ 8G). Exact attribute name in README: `nix build .#qcow2`.

- [ ] **Step 2: Document build command in README**

```bash
cd machines/nixos/vm && nix build .#qcow2 -L
```

- [ ] **Step 3: Commit**

```bash
git add machines/nixos/vm
git commit -m "Add MODC NixOS VM image flake"
```

---

### Task 3: Incus container flake

**Files:**
- Create: `machines/nixos/container/flake.nix`

**Interfaces:**
- Consumes: `../module`; nixpkgs `virtualisation/lxc-container.nix`
- Produces: squashfs + metadata importable by Incus (`nixos.incusContainerImage`-style outputs)

- [ ] **Step 1: Write flake**

Import `<nixpkgs/nixos/modules/virtualisation/lxc-container.nix>`, import `../module`, **override** `fileSystems."/modc/nixos-config"` to a bind-friendly stub (Incus disk device will provide the path—use `fsType = "none"; device = "/modc/nixos-config"; options = [ "bind" "ro" "nofail" ];` only if the host mounts into that path; otherwise omit filesystem entry and document that Incus disk device must mount at `/modc/nixos-config`).

Set `security.nesting` expectation in README (Incus config on create), enable enough for `nixos-rebuild`.

Build outputs: `config.system.build.squashfs` + `config.system.build.metadata` (or current nixpkgs Incus image attrs—match Hydra `incusContainerImage` names).

- [ ] **Step 2: Commit**

```bash
git add machines/nixos/container
git commit -m "Add MODC NixOS Incus container image flake"
```

---

### Task 4: CI build and release assets

**Files:**
- Create: `.github/workflows/nixos-images.yml`

**Interfaces:**
- Produces: GitHub Release assets `modc-nixos-<version>-amd64.qcow2`, `modc-nixos-<version>-amd64.squashfs`, `modc-nixos-<version>-amd64.incus.tar.xz`, and `.sha256` files

- [ ] **Step 1: Add workflow** that on tag `nixos-v*` (or workflow_dispatch) builds both flakes on `ubuntu-latest` with Nix installer, uploads checksummed artifacts to the release.

- [ ] **Step 2: Run a workflow_dispatch dry run** (or local `nix build`) and record sha256 of qcow2.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/nixos-images.yml
git commit -m "Build and publish MODC NixOS guest images"
```

---

### Task 5: Catalog entry

**Files:**
- Modify: `machines/catalog.json`

**Interfaces:**
- Produces: catalog image id `modc-nixos-24.11-amd64` (or current stable) with `familyId: "nixos"`, `kind: "cloud"`, `url` to release asset, pinned `checksums.sha256`, flag for Server: `"nixos": true` or rely on `familyId === "nixos"`

- [ ] **Step 1: Add image object**

```json
{
  "id": "modc-nixos-24.11-amd64",
  "familyId": "nixos",
  "name": "NixOS",
  "variantName": "Server",
  "version": "24.11",
  "arch": "amd64",
  "kind": "cloud",
  "url": "https://github.com/MyOwnDataCenter/app-store/releases/download/nixos-v24.11.0/modc-nixos-24.11-amd64.qcow2",
  "checksums": {"sha256": "REPLACE_AFTER_FIRST_RELEASE"},
  "sizeMb": 1200,
  "adminGroup": "wheel",
  "nixos": true
}
```

Use empty/minimal `cloudInit` (qemu-guest-agent already in image). Server Plan 3 detects `familyId === 'nixos'` or `nixos: true`.

- [ ] **Step 2: Commit**

```bash
git add machines/catalog.json
git commit -m "List MODC NixOS in the machines catalog"
```

---

## Verification

- `nix build` VM and container flakes succeed on x86_64.
- Manual: boot qcow2 under libvirt with 9p tag `modc-nixos-config` pointing at a dir with example `configuration.nix` → first boot applies.
- Catalog URL + sha256 match release assets.
- `scripts/check-catalog.mjs` (if present) still passes.
