---
name: install-custom-nixos-package
description: Package persistent custom software through ~/NixOS/packages. Use when requested software is unavailable or unsuitable in the active nixpkgs input.
available-if: |
  test -d "$HOME/NixOS/packages" &&
    test -f "$HOME/NixOS/packages/update.sh" &&
    command -v jq >/dev/null 2>&1 &&
    printf true
---

# Install A Custom NixOS Package

Configuration root: `~/NixOS`

## Package inventory

!`cd "$HOME/NixOS" && for directory in packages/*; do test -d "$directory" || continue; package=${directory##*/}; if test -f "$directory/update.json"; then printf '%s: updater=%s\n' "$package" "$(jq --raw-output '.type // "missing"' "$directory/update.json")"; else printf '%s: direct package definition\n' "$package"; fi; done | LC_ALL=C sort`

## Steps

### 1. Resolve the package source

Search, in order:

1. The active nixpkgs input.
2. Existing flake inputs and upstream Nix outputs.
3. Existing definitions under `~/NixOS/packages`.
4. Upstream release and source documentation.

Select an existing package or input when it meets the requirement. Continue with a custom definition when it does not.

**Complete when:** the selected package source and the configuration that will consume it are known.

### 2. Resolve custom updates

For a custom definition, read the closest package under `~/NixOS/packages` and inspect `packages/update.sh` before choosing a layout.

When upstream distributes changing external artifacts, follow [UPDATERS.md](UPDATERS.md) to resolve the update channel, updater type, and pinned source data.

**Complete when:** every external source has a reproducible version, URL, and SRI hash, plus an updater type when automated updates apply.

### 3. Implement the definition

Create `packages/<package-name>/package.nix` using the nearest repository pattern and the Nix primitive suited to the artifact: source build, archive derivation, AppImage wrapper, or another established form.

Updater-managed packages also use:

```text
packages/<package-name>/
├── package.nix
├── sources.json
└── update.json
```

Set accurate homepage, description, license, platforms, main program, and source provenance. Reproduce required installation behavior inside the derivation.

**Complete when:** the package evaluates for every declared platform and all source inputs are pinned.

### 4. Validate and install

From `~/NixOS`:

1. Validate changed JSON with `jq`.
2. Run `bash packages/update.sh <package-name>` when the package has an updater.
3. Build the package with `nix build "path:$HOME/NixOS#<package-name>" --no-link`.
4. Exercise a harmless version or help command when available.
5. Add the selected package to the appropriate Den aspect or Home Manager configuration.
6. Evaluate and build the affected system or home configuration.

Report licensing restrictions, native binaries, sandbox exceptions, unverified artifacts, and other reproducibility compromises. Request approval before switching or activating the built configuration.

**Complete when:** changed JSON is valid, the package and affected configuration build, and the response reports validation and activation status.
