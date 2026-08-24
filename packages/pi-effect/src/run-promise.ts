import { Cause, Context, Effect, Exit } from "effect";

export const USER_INTERRUPT_MESSAGE = "Interrupted by user.";

export const makeRunPromise = <Services>(context: Context.Context<Services>) => {
  const runPromiseExit = Effect.runPromiseExitWith(context);

  return <Value, Error>(
    effect: Effect.Effect<Value, Error, Services>,
    options?: Effect.RunOptions,
  ): Promise<Value> =>
    runPromiseExit(effect, options).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      if (
        options?.signal?.aborted === true &&
        Cause.hasInterruptsOnly(exit.cause)
      )
        throw new globalThis.Error(USER_INTERRUPT_MESSAGE);
      throw Cause.squash(exit.cause);
    });
};
