# Nix Software Installation Skill

An agent skill installs difficult development software declaratively instead of performing ad hoc machine changes.

- Search nixpkgs and existing inputs before creating a custom package.
- Add packages or modules to the appropriate Den aspect.
- Pin external sources and record update metadata.
- Evaluate and build the affected configuration before proposing activation.
- Explain licensing, binary, sandbox, and reproducibility compromises.
- Require approval before switching the live system.
- Leave no manual installation outside Nix ownership.

## References

- https://github.com/NixOS/nixpkgs
- https://github.com/denful/den
