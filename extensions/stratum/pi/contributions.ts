import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionCommandContext,
  MessageRenderer,
  RegisteredCommand,
  ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  HashMap,
  Layer,
  Order,
  SynchronizedRef,
  pipe,
} from "effect";
import { Host } from "./host/index.ts";

type ParameterSchema = PiToolDefinition["parameters"];
type PiCommandDefinition = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CommandCompletions = Awaited<
  ReturnType<NonNullable<PiCommandDefinition["getArgumentCompletions"]>>
>;

export type ToolDefinition<
  Parameters extends ParameterSchema = ParameterSchema,
  Details = unknown,
  State = unknown,
  Error = unknown,
> = Omit<PiToolDefinition<Parameters, Details, State>, "execute"> &
  Readonly<{
    execute: (
      ...args: globalThis.Parameters<
        PiToolDefinition<Parameters, Details, State>["execute"]
      >
    ) => Effect.Effect<
      Awaited<
        ReturnType<PiToolDefinition<Parameters, Details, State>["execute"]>
      >,
      Error,
      Host.Service | Host.Callback
    >;
  }>;

export type CommandDefinition<
  Error = unknown,
  CompletionError = unknown,
> = Omit<PiCommandDefinition, "handler" | "getArgumentCompletions"> &
  Readonly<{
    handler: (
      args: string,
      context: ExtensionCommandContext,
    ) => Effect.Effect<
      void,
      Error,
      Host.Service | Host.Callback | Host.Command
    >;
    getArgumentCompletions?: (
      argumentPrefix: string,
    ) => Effect.Effect<
      CommandCompletions,
      CompletionError,
      Host.Service
    >;
  }>;

export type ToolRegistration = ToolDefinition;

export type CommandRegistration = Readonly<{
  name: string;
  definition: CommandDefinition;
}>;

export type MessageRegistration = Readonly<{
  customType: string;
  renderer: MessageRenderer<unknown>;
}>;

export type EntryRegistration = Readonly<{
  customType: string;
  renderer: EntryRenderer<unknown>;
}>;

export type Registrations = Readonly<{
  tools: Array<ToolRegistration>;
  commands: Array<CommandRegistration>;
  renderers: Readonly<{
    messages: Array<MessageRegistration>;
    entries: Array<EntryRegistration>;
  }>;
}>;

type State = Readonly<{
  tools: HashMap.HashMap<string, ToolRegistration>;
  commands: HashMap.HashMap<string, CommandRegistration>;
  messages: HashMap.HashMap<string, MessageRegistration>;
  entries: HashMap.HashMap<string, EntryRegistration>;
}>;

type StateKey = keyof State;
type RegistrationOf<Key extends StateKey> =
  State[Key] extends HashMap.HashMap<string, infer Registration>
    ? Registration
    : never;

export type Contribution<Key extends StateKey> = Readonly<{
  key: Key;
  kind: string;
  name: string;
  registration: RegistrationOf<Key>;
}>;

export type Interface = Readonly<{
  tool: <Parameters extends ParameterSchema, Details, RendererState, Error>(
    definition: ToolDefinition<Parameters, Details, RendererState, Error>,
  ) => Effect.Effect<void>;
  command: <Error, CompletionError>(
    name: string,
    definition: CommandDefinition<Error, CompletionError>,
  ) => Effect.Effect<void>;
  message: <Details>(
    customType: string,
    renderer: MessageRenderer<Details>,
  ) => Effect.Effect<void>;
  entry: <Data>(
    customType: string,
    renderer: EntryRenderer<Data>,
  ) => Effect.Effect<void>;
  registrations: Effect.Effect<Registrations>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Pi.Contributions",
) {}

const sortedValues = <Value>(
  registrations: HashMap.HashMap<string, Value>,
): Array<Value> =>
  pipe(
    HashMap.toEntries(registrations),
    Arr.sortWith(([name]) => name, Order.String),
    Arr.map(([, registration]) => registration),
  );

type RuntimeServices = Host.Service | Service;

type RunPromise = <Value, Error>(
  effect: Effect.Effect<Value, Error, RuntimeServices>,
  options?: Effect.RunOptions,
) => Promise<Value>;

type EffectKey<Source> = {
  [Key in keyof Source]-?: NonNullable<Source[Key]> extends (
    ...args: never[]
  ) => Effect.Effect<unknown, unknown, unknown>
    ? Key
    : never;
}[keyof Source];

type ArgumentsOf<Value> =
  NonNullable<Value> extends (...args: infer Arguments) => unknown
    ? Arguments
    : never;

type Promisify<Value> = Value extends (
  ...args: infer Arguments
) => Effect.Effect<infer Success, unknown, unknown>
  ? (...args: Arguments) => Promise<Success>
  : Value;

type Promisified<Source, Key extends keyof Source> = {
  [Current in keyof Source]: Current extends Key
    ? Promisify<Source[Current]>
    : Source[Current];
};

type RunOptions<Source, Key extends keyof Source> = Partial<{
  [Current in Key]: (
    ...args: ArgumentsOf<Source[Current]>
  ) => Effect.RunOptions;
}>;

const promiseHandlers = <
  Source extends object,
  const Keys extends ReadonlyArray<EffectKey<Source>>,
>(
  runPromise: RunPromise,
  source: Source,
  keys: Keys,
  options: RunOptions<Source, Keys[number]> = {},
): Promisified<Source, Keys[number]> => {
  const result = { ...source };
  for (const key of keys) {
    const handler = Reflect.get(source, key);
    if (typeof handler !== "function") continue;
    const getOptions = Reflect.get(options, key);
    Reflect.set(result, key, (...args: unknown[]) =>
      runPromise(
        Reflect.apply(handler, source, args) as Effect.Effect<unknown, unknown>,
        typeof getOptions === "function"
          ? (Reflect.apply(getOptions, options, args) as Effect.RunOptions)
          : undefined,
      ),
    );
  }
  return result as Promisified<Source, Keys[number]>;
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State>({
      tools: HashMap.empty(),
      commands: HashMap.empty(),
      messages: HashMap.empty(),
      entries: HashMap.empty(),
    });

    const add = Effect.fn("Pi.Contributions.__add")(function* <
      Key extends StateKey,
    >(current: State, contribution: Contribution<Key>) {
      const registrations = current[contribution.key] as HashMap.HashMap<
        string,
        RegistrationOf<Key>
      >;
      if (HashMap.has(registrations, contribution.name)) {
        return yield* Effect.die(
          new Cause.IllegalArgumentError(
            `${contribution.kind} contribution ${JSON.stringify(contribution.name)} is already registered`,
          ),
        );
      }
      return {
        ...current,
        [contribution.key]: HashMap.set(
          registrations,
          contribution.name,
          contribution.registration,
        ),
      } as State;
    });

    const contribute = Effect.fn("Pi.Contributions.__contribute")(function* <
      Key extends StateKey,
    >(contribution: Contribution<Key>) {
      yield* SynchronizedRef.updateEffect(state, (current) =>
        add(current, contribution),
      );
    });

    const registrations: Interface["registrations"] = pipe(
      SynchronizedRef.get(state),
      Effect.map(
        (current): Registrations => ({
          tools: sortedValues(current.tools),
          commands: sortedValues(current.commands),
          renderers: {
            messages: sortedValues(current.messages),
            entries: sortedValues(current.entries),
          },
        }),
      ),
      Effect.withSpan("Pi.Contributions.registrations"),
    );

    const tool: Interface["tool"] = Effect.fn("Pi.Contributions.tool")(
      function* (definition) {
        yield* contribute({
          key: "tools",
          kind: "Tool",
          name: definition.name,
          registration: definition as unknown as ToolRegistration,
        });
      },
    );

    const command: Interface["command"] = Effect.fn("Pi.Contributions.command")(
      function* (name, definition) {
        yield* contribute({
          key: "commands",
          kind: "Command",
          name,
          registration: {
            name,
            definition: definition as CommandDefinition,
          },
        });
      },
    );

    const message: Interface["message"] = Effect.fn("Pi.Contributions.message")(
      function* (customType, renderer) {
        yield* contribute({
          key: "messages",
          kind: "Message renderer",
          name: customType,
          registration: {
            customType,
            renderer: renderer as MessageRenderer<unknown>,
          },
        });
      },
    );

    const entry: Interface["entry"] = Effect.fn("Pi.Contributions.entry")(
      function* (customType, renderer) {
        yield* contribute({
          key: "entries",
          kind: "Entry renderer",
          name: customType,
          registration: {
            customType,
            renderer: renderer as EntryRenderer<unknown>,
          },
        });
      },
    );

    return Service.of({
      tool,
      command,
      message,
      entry,
      registrations,
    });
  }),
);

export const register = Effect.fn("Pi.Contributions.register")(function* (
  pi: ExtensionAPI,
) {
  const contributions = yield* Service;
  const registrations = yield* contributions.registrations;
  const context = yield* Effect.context<RuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  yield* Effect.sync(() => {
    for (const definition of registrations.tools) {
      const contextual = {
        ...definition,
        execute: (toolCallId, parameters, signal, onUpdate, callbackContext) =>
          Host.provideCallback(
            definition.execute(
              toolCallId,
              parameters,
              signal,
              onUpdate,
              callbackContext,
            ),
            callbackContext,
          ),
      } satisfies ToolDefinition;
      pi.registerTool(
        promiseHandlers(runPromise, contextual, ["execute"], {
          execute: (_toolCallId, _parameters, signal) => ({ signal }),
        }),
      );
    }

    for (const registration of registrations.commands) {
      const contextual = {
        ...registration.definition,
        handler: (args, commandContext) =>
          Host.provideCommand(
            registration.definition.handler(args, commandContext),
            commandContext,
          ),
      } satisfies CommandDefinition;
      pi.registerCommand(
        registration.name,
        promiseHandlers(
          runPromise,
          contextual,
          ["handler", "getArgumentCompletions"],
          {
            handler: (_args, commandContext) => ({
              signal: commandContext.signal,
            }),
          },
        ),
      );
    }

    for (const registration of registrations.renderers.messages) {
      pi.registerMessageRenderer(
        registration.customType,
        registration.renderer,
      );
    }

    for (const registration of registrations.renderers.entries) {
      pi.registerEntryRenderer(registration.customType, registration.renderer);
    }
  });
});

export * as Contributions from "./contributions.ts";
