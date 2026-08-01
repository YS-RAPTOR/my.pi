# Workspace Boundary

The Herdr workspace is the project identity and communication boundary.

- Resources in one workspace may discover and communicate with each other.
- Resources do not cross workspace boundaries implicitly.
- Repositories, worktrees, and current directories do not create or change the boundary.
- A new boundary exists only when a Herdr workspace is explicitly opened or created.

## References

- https://github.com/ogulcancelik/herdr
