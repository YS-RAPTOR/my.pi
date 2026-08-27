import { Effect, Layer } from "effect";
import { Bridge } from "#o/bridge";
import { Prelude } from "#o/prelude";

const source = Prelude.dedent`
  class Shell {
    readonly id: string;

    constructor(id: string) {
      if (id.trim() === "") throw new TypeError("Shell ID must not be empty");
      this.id = id;
    }

    static async open(input: {
      command: string;
      cwd?: string;
      env?: Record<string, string | null>;
    }): Promise<Shell> {
      const result = await ${Bridge.Bootstrap.CALLABLE}<{ id: string }>("shell.open", input);
      console.log("Shell ID:", result.id);
      return new Shell(result.id);
    }

    static async list(input: { isRunning?: boolean } = {}): Promise<Shell[]> {
      const ids = await ${Bridge.Bootstrap.CALLABLE}<string[]>("shell.list", input);
      return ids.map((id) => new Shell(id));
    }

    read(input: { lines?: number | null; offset?: number } = {}) {
      return ${Bridge.Bootstrap.CALLABLE}<{
        text: string;
        continuation: { offset: number; remainingLines: number; } | null;
      }>("shell.read", { id: this.id, ...input });
    }

    write(text: string): Promise<void> {
      return ${Bridge.Bootstrap.CALLABLE}<void>("shell.write", { id: this.id, text });
    }

    sendKeys(keys: string[]): Promise<void> {
      return ${Bridge.Bootstrap.CALLABLE}<void>("shell.sendKeys", { id: this.id, keys });
    }

    info() {
      return ${Bridge.Bootstrap.CALLABLE}<{
        id: string;
        command: string;
        cwd: string;
        startedAt: number;
        isRunning: boolean;
        exitCode: number | null;
        signal: string | null;
      }>("shell.info", { id: this.id });
    }

    wait(timeout?: number) {
      return ${Bridge.Bootstrap.CALLABLE}<{
        id: string;
        command: string;
        cwd: string;
        startedAt: number;
        isRunning: boolean;
        exitCode: number | null;
        signal: string | null;
      }>("shell.wait", { id: this.id, timeout });
    }

    kill(): Promise<void> {
      return ${Bridge.Bootstrap.CALLABLE}<void>("shell.kill", { id: this.id });
    }
  }
`;

const docs: ReadonlyArray<Prelude.Doc> = [
  {
    name: "Shell",
    kind: "class",
    summary: "A reconnectable handle to a persistent terminal resource.",
    signature: Prelude.dedent`
      class Shell {
        readonly id: string;

        constructor(id: string);

        static open(input: {
          command: string;
          cwd?: string;
          env?: Record<string, string | null>;
        }): Promise<Shell>;

        static list(input?: { isRunning?: boolean }): Promise<Shell[]>;

        read(input?: { lines?: number | null; offset?: number }): Promise<{
          text: string;
          continuation: { offset: number; remainingLines: number; } | null;
        }>;
        write(text: string): Promise<void>;
        sendKeys(keys: string[]): Promise<void>;
        info(): Promise<{
          id: string;
          command: string;
          cwd: string;
          startedAt: number;
          isRunning: boolean;
          exitCode: number | null;
          signal: string | null;
        }>;
        wait(timeout?: number): Promise<{
          id: string;
          command: string;
          cwd: string;
          startedAt: number;
          isRunning: boolean;
          exitCode: number | null;
          signal: string | null;
        }>;
        kill(): Promise<void>;
      }
    `,
    description: Prelude.singleLine`
      A handle to a persistent terminal resource. \`Shell.open()\` creates a resource and
      returns its handle. \`new Shell(id)\` creates a handle for an existing resource without
      opening or validating it; the first host operation validates the ID.
    `,
    errors: ["The constructor throws when id is empty."],
    examples: [
      'const shell = new Shell("existing-shell-id")',
      "const devServer = await Shell.open({ command: $sh`npm run dev` })",
    ],
    keywords: ["shell", "terminal", "persistent", "resource", "handle", "reconnect"],
  },
  {
    name: "Shell.open",
    kind: "method",
    summary: "Creates a persistent terminal resource and returns its handle.",
    signature: Prelude.dedent`
      Shell.open(input: {
        // Bash command to run in the terminal.
        command: string;
        // Working directory. Defaults to the current session working directory.
        cwd?: string;
        // Environment overrides. A string sets a variable and \`null\` removes it.
        env?: Record<string, string | null>;
      }): Promise<
        // A reconnectable handle to the created terminal resource.
        Shell
      >
    `,
    description: Prelude.singleLine`
      \`Shell.open()\` starts a command in a new persistent terminal resource, displays to you its
      generated ID, and returns a reconnectable \`Shell\` handle. The resource continues
      running after the creating cell completes.
    `,
    errors: [
      "Throws when the input is invalid or the working directory cannot be used.",
      "Throws when the terminal resource cannot be created.",
    ],
    examples: [
      "const devServer = await Shell.open({ command: $sh`npm run dev` })",
      Prelude.dedent`
        const server = await Shell.open({
          command: $sh\`python -m http.server 8000\`,
          cwd: "./public",
          env: { DEBUG: "1", NODE_OPTIONS: null },
        })
      `,
    ],
    keywords: ["shell", "open", "terminal", "command", "process", "persistent"],
  },
  {
    name: "Shell.list",
    kind: "method",
    summary: "Lists persistent terminal resources as reconnectable handles.",
    signature: Prelude.dedent`
      Shell.list(input?: {
        // Return only running resources when \`true\` or completed resources when \`false\`.
        // Omit to return both.
        isRunning?: boolean;
      }): Promise<
        // Reconnectable handles ordered from newest to oldest.
        Shell[]
      >
    `,
    description: Prelude.singleLine`
      \`Shell.list()\` returns known terminal resources as \`Shell\` handles ordered from
      newest to oldest. It returns \`[]\` when no resources match. Call a handle's
      \`info()\` method when its command or current process state is needed.
    `,
    errors: ["Throws when terminal resources cannot be listed."],
    examples: [
      "const shells = await Shell.list()",
      "const running = await Shell.list({ isRunning: true })",
      Prelude.dedent`
        const shells = await Shell.list()
        const info = await Promise.all(shells.map((shell) => shell.info()))
      `,
    ],
    keywords: ["shell", "list", "terminal", "resources", "running", "completed"],
  },
  {
    name: "Shell.read",
    kind: "method",
    summary: "Reads visible output or paginated terminal history.",
    signature: Prelude.dedent`
      Shell.read(input?: {
        // Number of history lines to return. Omit or use \`null\` to read the currently
        // visible terminal pane.
        lines?: number | null;
        // Number of newest history lines to skip. Defaults to \`0\`. Use the returned
        // \`continuation.offset\` to read the next older page.
        offset?: number;
      }): Promise<{
        // Captured terminal output without added formatting.
        text: string;
        // Location of the next older history page, or \`null\` when reading the visible pane
        // or when no older lines remain.
        continuation: {
          // Offset to pass to the next read call.
          offset: number;
          // Number of older history lines still available.
          remainingLines: number;
        } | null;
      }>
    `,
    description: Prelude.singleLine`
      \`Shell.read()\` returns the currently visible terminal output by default. Pass a
      positive \`lines\` value to page backward through terminal history, following each
      returned \`continuation.offset\` until \`continuation\` is \`null\`. It can read running
      and completed resources.
    `,
    errors: [
      "Throws when the shell ID does not exist or the input is invalid.",
      "Throws when terminal output cannot be read.",
    ],
    examples: [
      "const output = await shell.read()",
      "const page = await shell.read({ lines: 200 })",
      Prelude.dedent`
        let page = await shell.read({ lines: 200 })
        const history = [page.text]

        while (page.continuation !== null) {
          page = await shell.read({
            lines: 200,
            offset: page.continuation.offset,
          })
          history.unshift(page.text)
        }
      `,
    ],
    keywords: ["shell", "read", "terminal", "output", "history", "pagination"],
  },
  {
    name: "Shell.write",
    kind: "method",
    summary: "Writes literal text to a running terminal resource.",
    signature: Prelude.dedent`
      Shell.write(
        // Literal terminal input sent without appending characters or interpreting named keys.
        text: string,
      ): Promise<void>
    `,
    description: Prelude.singleLine`
      \`Shell.write()\` sends text exactly as provided without appending characters or
      generating named key events. The receiving process decides what the text means. Use
      \`sendKeys()\` when a named keyboard action is required. Its behavior is equivalent
      to \`tmux send-keys -l -- <text>\`.
    `,
    errors: [
      "Throws when the shell ID does not exist or the resource is no longer running.",
      "Throws when the text cannot be written.",
    ],
    examples: [
      Prelude.dedent`
        const python = await Shell.open({ command: $sh\`python\` })
        await python.write($py\`print("hello")\`)
        await python.sendKeys(["Enter"])
      `,
      Prelude.dedent`
        const bash = await Shell.open({ command: $sh\`bash\` })
        await bash.write($sh\`pwd\`)
        await bash.sendKeys(["Enter"])
      `,
      Prelude.dedent`
        const agent = await Shell.open({ command: $sh\`pi\` })
        await agent.write("Explain the current test failure.")
        await agent.sendKeys(["Enter"])
      `,
      Prelude.dedent`
        const prompt = await Shell.open({
          command: $sh\`read -r answer; printf 'received: %s\\n' "$answer"\`,
        })
        await prompt.write("hello\\n")
      `,
    ],
    keywords: ["shell", "write", "terminal", "input", "stdin", "literal"],
  },
  {
    name: "Shell.sendKeys",
    kind: "method",
    summary: "Sends named keyboard actions to a running terminal resource.",
    signature: Prelude.dedent`
      Shell.sendKeys(
        // Tmux key names sent in order, such as \`Enter\`, \`Escape\`, \`C-c\`, \`Up\`, or \`Down\`.
        keys: string[],
      ): Promise<void>
    `,
    description: Prelude.singleLine`
      \`Shell.sendKeys()\` sends each entry as a named keyboard action in order. Key names
      use \`tmux\`'s \`send-keys\` syntax. Use \`write()\` instead for literal text. Its
      behavior is equivalent to \`tmux send-keys -- <key>...\`.
    `,
    errors: [
      "Throws when the shell ID does not exist or the resource is no longer running.",
      "Throws when the named keys cannot be sent.",
    ],
    examples: [
      'await shell.sendKeys(["Enter"])',
      'await shell.sendKeys(["C-c"])',
      'await shell.sendKeys(["Up", "Enter"])',
    ],
    keywords: ["shell", "send", "keys", "keyboard", "terminal", "tmux"],
  },
  {
    name: "Shell.info",
    kind: "method",
    summary: "Gets the current terminal resource information.",
    signature: Prelude.dedent`
      Shell.info(): Promise<{
        // Stable resource ID used to reconnect with \`new Shell(id)\`.
        id: string;
        // Command originally used to create the resource.
        command: string;
        // Absolute working directory in which the command was started.
        cwd: string;
        // Unix timestamp in milliseconds when the resource was created.
        startedAt: number;
        // Whether the command is still running.
        isRunning: boolean;
        // Process exit code after completion, or \`null\` while running or unavailable.
        exitCode: number | null;
        // Terminating signal name after completion, or \`null\` while running or unavailable.
        signal: string | null;
      }>
    `,
    description: Prelude.singleLine`
      \`Shell.info()\` returns the resource's current state. Every call performs a fresh
      host request and observes whether a previously running command has completed.
    `,
    errors: [
      "Rejects when the shell ID does not exist.",
      "Rejects when the terminal resource information cannot be read.",
    ],
    examples: [
      "const info = await shell.info()",
      Prelude.dedent`
        const info = await shell.info()
        if (!info.isRunning) {
          console.log(info.exitCode, info.signal)
        }
      `,
    ],
    keywords: ["shell", "info", "terminal", "status", "running", "exit", "signal"],
  },
  {
    name: "Shell.wait",
    kind: "method",
    summary: "Waits for completion or a timeout and returns the current state.",
    signature: Prelude.dedent`
      Shell.wait(
        // Maximum seconds to wait. Defaults to the configured shell wait timeout.
        timeout?: number,
      ): Promise<{
        // Stable resource ID used to reconnect with \`new Shell(id)\`.
        id: string;
        // Command originally used to create the resource.
        command: string;
        // Absolute working directory in which the command was started.
        cwd: string;
        // Unix timestamp in milliseconds when the resource was created.
        startedAt: number;
        // Whether the command is still running when the wait ends.
        isRunning: boolean;
        // Process exit code after completion, or \`null\` while running or unavailable.
        exitCode: number | null;
        // Terminating signal name after completion, or \`null\` while running or unavailable.
        signal: string | null;
      }>
    `,
    description: Prelude.singleLine`
      \`Shell.wait()\` waits until the command completes or the timeout elapses, then
      returns the same current state as \`info()\`. A timeout is not an error and does not
      stop the command; \`isRunning\` remains \`true\` when the timeout elapsed first.
      Completed resources return immediately.
    `,
    errors: [
      "Throws when the shell ID does not exist or the timeout is invalid.",
      "Throws when the resource cannot be awaited or its state cannot be read.",
    ],
    examples: [
      "const info = await shell.wait()",
      Prelude.dedent`
        const info = await shell.wait(10)
        if (info.isRunning) {
          console.log("Still running")
        }
      `,
      Prelude.dedent`
        const info = await shell.wait(120)
        if (!info.isRunning) {
          console.log(info.exitCode, info.signal)
        }
      `,
    ],
    keywords: ["shell", "wait", "terminal", "timeout", "completion", "exit", "signal"],
  },
  {
    name: "Shell.kill",
    kind: "method",
    summary: "Forcefully terminates a terminal resource.",
    signature: Prelude.dedent`
      Shell.kill(): Promise<void>
    `,
    description: Prelude.singleLine`
      \`Shell.kill()\` sends \`SIGKILL\` to the running process group, waits for it to
      stop, and finalizes its captured output. It returns without doing anything when the
      resource has already completed.
    `,
    errors: [
      "Throws when the shell ID does not exist.",
      "Throws when the process group cannot be terminated or the resource cannot be finalized.",
    ],
    examples: [
      "await shell.kill()",
      Prelude.dedent`
        const info = await shell.info()
        if (info.isRunning) await shell.kill()
      `,
    ],
    keywords: ["shell", "kill", "terminal", "terminate", "stop", "process", "signal"],
  },
];

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const preludes = yield* Prelude.Service;
    yield* preludes.register({ name: "shell", source, docs });
  }),
);
