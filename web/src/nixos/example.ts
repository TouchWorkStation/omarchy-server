export function isNixosOs(os: string): boolean {
	return /^nixos$/i.test(String(os ?? '').trim())
}

export const NIXOS_EXAMPLE_VM = `# Example NixOS configuration for a libvirt VM (no flakes).
# Enables QEMU guest agent so the host can see address and lifecycle.

{ config, pkgs, ... }:

{
  networking.hostName = "nixos-vm";

  boot.loader.grub.enable = true;

  services.qemuGuest.enable = true;

  environment.systemPackages = with pkgs; [
    vim
  ];

  system.stateVersion = "24.11";
}
`

export const NIXOS_EXAMPLE_LXC = `# Example NixOS configuration for an Incus system container (no flakes).

{ config, pkgs, modulesPath, ... }:

{
  imports = [
    "\${modulesPath}/virtualisation/lxc-container.nix"
  ];

  networking.hostName = "nixos-lxc";

  environment.systemPackages = with pkgs; [
    vim
  ];

  system.stateVersion = "24.11";
}
`