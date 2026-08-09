import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as ShellCall from "./shell-call.ts";
import * as ShellResource from "./shell-resource.ts";
import * as ShellResult from "./shell-result.ts";
import type {
  CallModel,
  CallSource,
  FooterModel,
  ResultModel,
  ResultSource,
} from "./types.ts";

type Definition<Input, Details> = Readonly<{
  call: (source: CallSource<Input>) => CallModel;
  resource: (source: ResultSource<Input, Details>) => ShellResource.Model;
  errorResult: (source: ResultSource<Input, Details>) => ResultModel;
  errorFooter: (source: ResultSource<Input, Details>) => FooterModel;
}>;

type CallContext<Input> = Readonly<{
  args: Input;
  cwd: string;
  lastComponent: Component | undefined;
}>;

type ResultContext<Input> = Readonly<{
  args: Input;
  lastComponent: Component | undefined;
  isError: boolean;
}>;

export const make = <Input, Details>(
  definition: Definition<Input, Details>,
) => ({
  renderCall(
    input: Input,
    theme: Theme,
    context: CallContext<Input>,
  ): Component {
    const source: CallSource<Input> = {
      input,
      cwd: context.cwd,
    };
    return ShellCall.render(
      definition.call(source),
      theme,
      context.lastComponent,
    );
  },

  renderResult(
    result: AgentToolResult<Details>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ResultContext<Input>,
  ): Component {
    const source: ResultSource<Input, Details> = {
      input: context.args,
      result,
      details: result.details,
      options,
      isError: context.isError,
    };
    if (context.isError || result.details === undefined) {
      return ShellResult.render(
        definition.errorResult(source),
        definition.errorFooter(source),
        theme,
        context.lastComponent,
        options.expanded,
        context.isError,
      );
    }
    return ShellResource.render(
      definition.resource(source),
      theme,
      context.lastComponent,
    );
  },
});
