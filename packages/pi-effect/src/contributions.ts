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
      Host.Service | Host.Callback | Host.CallbackContext
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
      | Host.Service
      | Host.Callback
      | Host.CallbackContext
      | Host.Command
      | Host.CommandContext
    >;
    getArgumentCompletions?: (
      argumentPrefix: string,
    ) => Effect.Effect<CommandCompletions, CompletionError, Host.Service>;
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
  "@ys-raptor/pi-effect/Contributions",
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
      // SAFETY: each State key owns a HashMap containing RegistrationOf<Key>.
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
      // SAFETY: the computed key is preserved and receives its corresponding registration type.
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
          // SAFETY: registration erases only the tool's generic detail and error parameters.
          registration: definition as ToolRegistration,
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
            // SAFETY: registration erases only command-specific error parameters.
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
            // SAFETY: the custom type keeps the renderer paired with its original details.
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
            // SAFETY: the custom type keeps the renderer paired with its original entry data.
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
      pi.registerTool({
        ...contextual,
        execute: (toolCallId, parameters, signal, onUpdate, callbackContext) =>
          runPromise(
            contextual.execute(
              toolCallId,
              parameters,
              signal,
              onUpdate,
              callbackContext,
            ),
            { signal },
          ),
      });
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
      const handler = (args: string, commandContext: ExtensionCommandContext) =>
        runPromise(contextual.handler(args, commandContext), {
          signal: commandContext.signal,
        });
      const { getArgumentCompletions, ...commandDefinition } = contextual;
      pi.registerCommand(
        registration.name,
        getArgumentCompletions === undefined
          ? { ...commandDefinition, handler }
          : {
              ...commandDefinition,
              handler,
              getArgumentCompletions: (argumentPrefix) =>
                runPromise(getArgumentCompletions(argumentPrefix)),
            },
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
