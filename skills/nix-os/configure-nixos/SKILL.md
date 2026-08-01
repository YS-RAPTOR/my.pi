---
name: configure-nixos
description: Configure this NixOS system declaratively in ~/NixOS. Use when inspecting or changing system, Home Manager, host, user, package, or development configuration.
available-if: |
  test -d "$HOME/NixOS" && printf true
---

# Configure NixOS

Configuration root: `~/NixOS`

## Directory tree

!`cd "$HOME/NixOS" && printf 'NixOS/\n' && while IFS= read -r path; do relative=${path#./}; nesting=${relative//[^\/]/}; printf '%*s%s/\n' $(((${#nesting} + 1) * 2)) '' "${relative##*/}"; done < <(find . -mindepth 1 -type d \( -name '.*' -o -name node_modules \) -prune -o -type d -print | LC_ALL=C sort)`

Locate the relevant subtree, inspect its files, and keep persistent changes declarative. Validate and build the affected configuration; request approval before switching or activating it.
