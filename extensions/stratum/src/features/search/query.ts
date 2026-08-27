import { Array as Arr, Effect, FileSystem, Match, Option, Path, String as Str, pipe } from "effect";

const GLOB = /[*?[{]/;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const UNCONSTRAINED = new Set(["", ".", "**", "**/", "**/*"]);

export const normalizePathConstraint = (
  paths: Path.Path,
  pathConstraint: string,
  cwd: string,
): string | null => {
  const input = pathConstraint.trim();
  if (input === "") return input;

  const absolute = paths.isAbsolute(input);
  const relative = absolute ? paths.relative(cwd, input).replaceAll(paths.sep, "/") : input;
  const outsideWorkspace =
    relative === ".." || relative.startsWith("../") || paths.isAbsolute(relative);
  if (absolute && outsideWorkspace) {
    throw new Error(`Path constraint must be relative to the workspace: ${pathConstraint}`);
  }

  const constraint = relative.replace(/^\.\//, "");
  if (UNCONSTRAINED.has(constraint)) return null;

  const recursiveDirectory = constraint.match(/^(.*)\/\*\*(?:\/\*)?$/)?.[1];
  if (recursiveDirectory !== undefined && !GLOB.test(recursiveDirectory)) {
    return `${recursiveDirectory}/`;
  }
  if (constraint.endsWith("/") || GLOB.test(constraint)) return constraint;

  const filename = constraint.split("/").at(-1) ?? "";
  return FILE_EXTENSION.test(filename) ? constraint : `${constraint}/`;
};

export const buildQuery = (
  paths: Path.Path,
  pathConstraint: string | undefined,
  pattern: string,
  exclude: string | ReadonlyArray<string> | undefined,
  cwd: string,
): string => {
  const normalize = (value: string | null | undefined) =>
    pipe(
      Option.fromNullishOr(value),
      Option.flatMap((constraint) =>
        Option.fromNullishOr(normalizePathConstraint(paths, constraint, cwd)),
      ),
      Option.filter(Str.isNonEmpty),
    );
  const excluded = pipe(
    Match.value(exclude),
    Match.when(Match.string, (value) => [value]),
    Match.orElse((value) => value ?? []),
  );
  const exclusions = pipe(
    excluded,
    Arr.flatMap((value) => value.split(/[,\s]+/)),
    Arr.map((value) => value.trim().replace(/^!/, "")),
    Arr.flatMap((value) =>
      pipe(
        normalize(value),
        Option.map((constraint) => `!${constraint}`),
        Arr.fromOption,
      ),
    ),
  );
  return pipe(
    normalize(pathConstraint),
    Arr.fromOption,
    Arr.appendAll(exclusions),
    Arr.append(pattern),
    Arr.join(" "),
  );
};

export const rootCovers = (paths: Path.Path, root: string, target: string): boolean =>
  root === target || target.startsWith(root.endsWith(paths.sep) ? root : `${root}${paths.sep}`);

export type Route = Readonly<{ root: string; suffix: string }>;

export const resolveAuxRoot = Effect.fn("Features.Search.Query.resolveAuxRoot")(function* (
  input: string,
) {
  const files = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const normalized = paths.normalize(input.trim()).replace(/\/+$/, "") || paths.sep;
  if (!paths.isAbsolute(normalized)) return null;
  if (normalized === paths.sep) return { root: paths.sep, suffix: "" } satisfies Route;

  const parts = normalized.split(paths.sep);
  const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
  const boundary = firstGlob === -1 ? parts.length : firstGlob;
  const candidates = pipe(
    Arr.range(1, boundary),
    Arr.reverse,
    Arr.map((index) => ({
      index,
      path: parts.slice(0, index).join(paths.sep) || paths.sep,
    })),
  );
  const found = yield* Effect.findFirst(candidates, ({ path }) =>
    pipe(
      files.exists(path),
      Effect.orElseSucceed(() => false),
    ),
  );
  if (Option.isNone(found)) return null;

  return yield* pipe(
    files.stat(found.value.path),
    Effect.match({
      onFailure: () => null,
      onSuccess: (info) =>
        pipe(
          Match.value(info.type),
          Match.when("File", () => ({
            root: parts.slice(0, found.value.index - 1).join(paths.sep) || paths.sep,
            suffix: parts.slice(found.value.index - 1).join("/"),
          })),
          Match.orElse(() => ({
            root: found.value.path,
            suffix: parts.slice(found.value.index).join("/"),
          })),
        ),
    }),
  );
});

export const routePathConstraint = Effect.fn("Features.Search.Query.routePathConstraint")(
  function* (pathConstraint: string | undefined, cwd: string, home: string) {
    const constraint = pipe(
      Option.fromNullishOr(pathConstraint),
      Option.map(Str.trim),
      Option.filter(Str.isNonEmpty),
    );
    if (Option.isNone(constraint)) return null;

    const paths = yield* Path.Path;
    const candidate = pipe(
      Match.value(constraint.value),
      Match.when(
        (value) => value === "~" || value.startsWith("~/"),
        (value) => paths.join(home, value.slice(1)),
      ),
      Match.when(
        (value) => paths.isAbsolute(value),
        (value) => value,
      ),
      Match.when(
        (value) => value === ".." || value.startsWith("../"),
        (value) => paths.resolve(cwd, value),
      ),
      Match.orElse(() => null),
    );
    if (candidate === null) return null;

    const relative = paths.relative(cwd, candidate);
    const insideWorkspace =
      !paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`);
    if (insideWorkspace) return null;
    return yield* resolveAuxRoot(candidate);
  },
);
