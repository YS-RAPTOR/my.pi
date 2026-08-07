import { Context, Layer } from "effect";

export type Interface = Readonly<{
  shell: Readonly<{
    stdio: Readonly<{
      stdinCapacity: number;
    }>;
    herdr: Readonly<{
      requestTimeoutMillis: number;
      requestRetries: number;
      requestRetryMillis: number;
      maximumMessageBytes: number;
      startupAttempts: number;
      startupPollMillis: number;
      shutdownTimeoutMillis: number;
      waitPollMillis: number;
      descriptorTokenBytes: number;
    }>;
  }>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Config",
) {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    shell: {
      stdio: {
        stdinCapacity: 16,
      },
      herdr: {
        requestTimeoutMillis: 2_000,
        requestRetries: 3,
        requestRetryMillis: 50,
        maximumMessageBytes: 1024 * 1024,
        startupAttempts: 100,
        startupPollMillis: 50,
        shutdownTimeoutMillis: 3_000,
        waitPollMillis: 100,
        descriptorTokenBytes: 24,
      },
    },
  }),
);

export * as Config from "./index.ts";
