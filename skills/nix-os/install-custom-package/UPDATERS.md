# Custom Package Updaters

## Resolve the update channel

Read upstream installation and release documentation. When upstream presents an installer script, read the script as source documentation and trace its version lookup, manifest, artifact URL, platform mapping, verification, unpacking, and post-install behavior. Represent the underlying artifact channel in Nix.

**Complete when:** the authoritative machine-readable version and artifact endpoint are known for each supported platform.

## Select the updater type

Read `~/NixOS/packages/update.sh` and nearby `update.json` files. Every `update.json` declares a `type`.

Reuse a type whose schema represents the artifact channel. For a new channel, add one generic dispatch type with:

- a validated JSON schema;
- package-specific selectors and asset names in `update.json`;
- clear failure for missing or unsupported values;
- version, URL, and SRI hash output in `sources.json`.

GitHub release assets use `github-release` when its existing schema fits.

**Complete when:** a generic updater type plus `update.json` data can resolve the package.

## Pin the source

`update.json` describes resolution; `sources.json` records resolved source data by Nix system; `package.nix` consumes only `sources.json`.

Run the targeted updater and inspect its changes:

```bash
bash packages/update.sh <package-name>
```

Validate each JSON file and build the package from the updated source data.

**Complete when:** the current system has a resolved version, URL, and SRI hash and the resulting package builds.
