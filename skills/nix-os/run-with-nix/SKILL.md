---
name: run-with-nix
description: Run a missing temporary command through Nix. Use when a task needs a command or dependency that is unavailable in the current environment.
available-if: |
  command -v nix >/dev/null 2>&1 &&
    test -r /etc/os-release &&
    grep -qx 'ID=nixos' /etc/os-release &&
    printf true
---

# Run With Nix

## Environment

!`if test -f flake.nix; then printf 'Project flake: present\n'; else printf 'Project flake: absent\n'; fi; if test -n "${IN_NIX_SHELL:-}"; then printf 'Nix shell: active (%s)\n' "$IN_NIX_SHELL"; else printf 'Nix shell: not detected\n'; fi`

`IN_NIX_SHELL` is a shell hint; command availability and project documentation identify the usable environment.

## Steps

### 1. Reuse the environment

Check `command -v <command>` and use an available command directly. When the project has a flake, inspect its documentation and outputs for the intended task or development shell.

Run a project development shell while preserving its lock file:

```bash
nix develop --no-write-lock-file -c <command> <args...>
nix develop --no-write-lock-file .#<shell-name> -c <command> <args...>
```

**Complete when:** the existing environment or project shell can run the command, or neither provides it.

### 2. Select an ephemeral package

Use `nix run` for a package's primary executable:

```bash
nix run nixpkgs#<package-attribute> -- <args...>
```

Use `nix shell` when the command name differs from the package attribute or the command needs multiple packages:

```bash
nix shell nixpkgs#<package-attribute> -c <command> <args...>
nix shell nixpkgs#<first-package> nixpkgs#<second-package> -c <command> <args...>
```

Resolve uncertain attributes with `nix search nixpkgs <query>`.

**Complete when:** the narrowest Nix command has completed the task.

### 3. Report

Name the package attribute and exact command used. Keep temporary execution ephemeral: preserve the NixOS configuration, Home Manager configuration, project flake and lock file, and user profile. Route persistent software to the declarative configuration or custom-package skill.

**Complete when:** the response makes the command reproducible and identifies the declarative route when persistence is requested.
