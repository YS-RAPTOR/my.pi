# Package References

## Source-first selection

Read installed-package metadata, the project lockfile, and registry metadata to identify the package's repository.

- For authored source, implementation, tests, or history, use the matching GitHub reference when it can be resolved reliably; return to [GITHUB.md](GITHUB.md).
- For generated declarations, bundles, exports, post-install files, or other shipped contents, use the package artifact.
- Use the package artifact when no reliable repository can be identified.

## Identity

Use:

```text
~/.references/<ecosystem>/<normalized-package-identity>/<intent>/
```

Choose the ecosystem's canonical shared name, such as npm, pypi, crates, maven, etc. Keep the canonical package identity in one directory and replace each `/` with `--`; preserve its other meaningful syntax.

Examples:

```text
@effect/platform → npm/@effect--platform
requests         → pypi/requests
serde            → crates/serde
```

Verify canonical identity from the materialized package metadata. An occupied path with a different identity is a collision; leave it unchanged and report it.

## Intents

```text
tracking-<channel>
pinned-version-<exact-version>
```

Use the ecosystem's meaning of a moving channel, such as `latest`, `next`, `beta`, or `canary`. Exact versions use the pinned intent.

## Steps

### 1. Resolve the selector

Resolve a channel to its current exact version, or retain the requested exact version. Determine the final intent path.

**Complete when:** the canonical package identity, intent path, and exact selected version are known.

### 2. Inspect the target

If the intent path exists, verify its package metadata, canonical identity, exact version, and ecosystem integrity or checksum when available.

**Complete when:** the existing artifact is confirmed valid or rejected with a specific mismatch.

### 3. Apply the intent

Reuse a valid pinned artifact unchanged. For a valid tracking artifact, refresh it only when its channel currently resolves to a different version.

If materialization is required, use the ecosystem's native download, pack, cache, or extraction command to place only the requested package in the intent path while leaving the current project's package-manager state unchanged.

Verify the result using step 2.

**Complete when:** the intent path contains the requested package at the resolved version.
