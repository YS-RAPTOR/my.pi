import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as ShellCall from "./shell-call.ts";
import * as ShellResource from "./shell-resource.ts";
import * as ShellResourceList from "./shell-resource-list.ts";
import * as ShellResult from "./shell-result.ts";
import type {
  CallModel,
  CallSource,
  FooterModel,
  ResultModel,
  ResultSource,
} from "./types.ts";

type Definition<Input, Details, ResourceDetails> = Readonly<{
  call: (source: CallSource<Input>) => CallModel;
  resources: (details: Details) => ReadonlyArray<ResourceDetails>;
  resource: (
    source: ResultSource<Input, ResourceDetails>,
  ) => ShellResource.Model;
  fallbackResult: (source: ResultSource<Input, Details>) => ResultModel;
  fallbackFooter: (source: ResultSource<Input, Details>) => FooterModel;
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

export const make = <Input, Details, ResourceDetails>(
  definition: Definition<Input, Details, ResourceDetails>,
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
    const resources =
      result.details === undefined
        ? []
        : definition.resources(result.details);
    if (context.isError || resources.length === 0) {
      return ShellResult.render(
        definition.fallbackResult(source),
        definition.fallbackFooter(source),
        theme,
        context.lastComponent,
        options.expanded,
        context.isError,
      );
    }

    const models: Array<ShellResource.Model> = [];
    for (const details of resources) {
      const resourceResult: AgentToolResult<ResourceDetails> = {
        content: result.content,
        details,
      };
      const resourceSource: ResultSource<Input, ResourceDetails> = {
        input: context.args,
        result: resourceResult,
        details,
        options,
        isError: false,
      };
      models.push(definition.resource(resourceSource));
    }
    return ShellResourceList.render(
      models,
      theme,
      context.lastComponent,
    );
  },
});
