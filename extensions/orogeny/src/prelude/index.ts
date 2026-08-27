import { dedent, singleLine } from "./dedent.ts";
import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Match,
  Order,
  SynchronizedRef,
  pipe,
} from "effect";

export type DocKind = "class" | "method" | "namespace" | "function" | "language" | "value";

export type Doc = Readonly<{
  name: string;
  kind: DocKind;
  summary: string;
  signature: string;
  description: string;
  errors: ReadonlyArray<string>;
  examples: ReadonlyArray<string>;
  keywords: ReadonlyArray<string>;
}>;

export type Contribution = Readonly<{
  name: string;
  source: string;
  docs?: ReadonlyArray<Doc>;
}>;

type Registration = Readonly<{
  name: string;
  source: string;
  docs: ReadonlyArray<Doc>;
}>;

export type Interface = Readonly<{
  register: (contribution: Contribution) => Effect.Effect<void>;
  get: Effect.Effect<string>;
  docs: Effect.Effect<ReadonlyArray<Doc>>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Prelude") {}

const docOrder = pipe(
  Order.Tuple([Order.String, Order.String]),
  Order.mapInput((doc: Doc) => [doc.kind, doc.name] as const),
);

const docsDoc: Doc = {
  name: "$docs",
  kind: "value",
  summary: "Documentation for stable notebook APIs and language helpers.",
  signature: dedent`
    const $docs: readonly Readonly<{
      name: string;
      kind: "class" | "method" | "namespace" | "function" | "language" | "value";
      summary: string;
      signature: string;
      description: string;
      errors: readonly string[];
      examples: readonly string[];
      keywords: readonly string[];
    }>[]
  `,
  description: singleLine`
    An immutable catalog of stable notebook namespaces, functions, values, and language
    helpers. Use normal array methods such as \`filter()\`, \`find()\`, and \`map()\` to
    inspect it. Dynamic MCP servers and tools are not included.
  `,
  errors: [],
  examples: [
    '$docs.filter((doc) => `${doc.name} ${doc.summary}`.toLowerCase().includes("patch"))',
    '$docs.find((doc) => doc.name === "pi.bash")',
  ],
  keywords: ["documentation", "help", "search", "discovery"],
};

const catalog = (registrations: HashMap.HashMap<string, Registration>) =>
  pipe(
    HashMap.values(registrations),
    Arr.fromIterable,
    Arr.flatMap((registration) => registration.docs),
    Arr.prepend(docsDoc),
    Arr.sort(docOrder),
  );

const catalogSource = (docs: ReadonlyArray<Doc>) => dedent`
  const $docs = Object.freeze(
    ${JSON.stringify(docs)}.map((doc) => Object.freeze({
      ...doc,
      errors: Object.freeze(doc.errors),
      examples: Object.freeze(doc.examples),
      keywords: Object.freeze(doc.keywords),
    })),
  ) as readonly Readonly<{
    name: string;
    kind: "class" | "method" | "namespace" | "function" | "language" | "value";
    summary: string;
    signature: string;
    description: string;
    errors: readonly string[];
    examples: readonly string[];
    keywords: readonly string[];
  }>[];
`;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registrations = yield* SynchronizedRef.make(HashMap.empty<string, Registration>());

    const register: Interface["register"] = Effect.fn("Orogeny.Prelude.register")(
      function* (contribution) {
        yield* SynchronizedRef.updateEffect(registrations, (current) => {
          const docs = contribution.docs ?? [];
          const names = pipe(
            [...catalog(current), ...docs],
            Arr.map((doc) => doc.name),
          );
          if (HashSet.size(HashSet.fromIterable(names)) !== names.length)
            return Effect.die(
              new Cause.IllegalArgumentError("Prelude documentation names must be unique"),
            );

          return pipe(
            Match.value(HashMap.has(current, contribution.name)),
            Match.when(true, () =>
              Effect.die(
                new Cause.IllegalArgumentError(
                  `Prelude ${JSON.stringify(contribution.name)} is already registered`,
                ),
              ),
            ),
            Match.when(false, () =>
              Effect.succeed(
                HashMap.set(current, contribution.name, {
                  name: contribution.name,
                  source: contribution.source,
                  docs,
                }),
              ),
            ),
            Match.exhaustive,
          );
        });
      },
    );

    const docs: Interface["docs"] = pipe(
      SynchronizedRef.get(registrations),
      Effect.map(catalog),
      Effect.withSpan("Orogeny.Prelude.docs"),
    );

    const get: Interface["get"] = pipe(
      SynchronizedRef.get(registrations),
      Effect.map((current) => {
        const currentDocs = catalog(current);
        return pipe(
          HashMap.values(current),
          Arr.fromIterable,
          Arr.sortWith((registration) => registration.name, Order.String),
          Arr.map((registration) => registration.source),
          Arr.append(catalogSource(currentDocs)),
          Arr.join("\n\n"),
        );
      }),
      Effect.withSpan("Orogeny.Prelude.get"),
    );

    return Service.of({ register, get, docs });
  }),
);

export { dedent, singleLine } from "./dedent.ts";
export * as Prelude from "./index.ts";
