# GitHub References

## Identity

Use:

```text
~/.references/github/<owner>--<repository>/<intent>/
```

Lowercase the canonical `owner/repository` identity and replace `/` with `--`.

Example:

```text
earendil-works/pi → github/earendil-works--pi
```

Verify the checkout's normalized `origin` identity before reuse. An occupied path with a different origin is an identity collision; leave it unchanged and report it.

## Intents

```text
tracking-branch-<branch>
tracking-pr-<number>
pinned-branch-<branch>-at-<full-commit>
pinned-pr-<number>-at-<full-commit>
pinned-tag-<tag>
pinned-commit-<full-commit>
```

Encode `%` as `%25`, then `/` as `%2F`, in branch and tag names. Use full commit SHAs.

- **Tracking branch:** current source from a named branch.
- **Tracking pull request:** current head of a pull request in its base repository.
- **Pinned branch:** one commit with branch provenance.
- **Pinned pull request:** one head commit with pull-request provenance.
- **Pinned tag:** the local snapshot selected by a tag.
- **Pinned commit:** one commit without useful branch, pull-request, or tag provenance.

Resolve repository URLs to a named branch, pull-request URLs to the base repository plus PR number and head commit, and release URLs to a tag.

## Steps

### 1. Inspect the target

If the intent path exists, verify that it:

- is a Git worktree;
- has the requested normalized `origin` identity;
- has a clean status;
- matches the branch, pull-request ref, tag, and `HEAD` encoded by its intent.

**Complete when:** the existing checkout is confirmed valid or rejected with a specific mismatch.

### 2. Apply the intent

For a valid tracking reference, fetch its named branch or GitHub pull-request head ref and advance with fast-forward-only behavior. Report a non-fast-forward update or dirty checkout without resetting it.

For a valid pinned reference, preserve its current refs and `HEAD` unchanged.

If the reference is missing, clone the canonical GitHub repository directly into the intent path and fetch the selector needed to establish the requested branch, pull-request head, tag, or commit. Check out pinned commits detached. Verify the completed checkout using step 1.

**Complete when:** the intent path contains a clean checkout at the requested resolution.
