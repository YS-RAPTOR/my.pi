import type {
  AgentToolResult,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

export type Mode = "stdio" | "pty";

export type CallSource<Input> = Readonly<{
  input: Partial<Input> | undefined;
  cwd: string;
}>;

export type MetadataRow = Readonly<{
  label: string;
  value: string;
}>;

export type CallModel = Readonly<{
  name: string;
  mode: Mode | undefined;
  primary: string | undefined;
  metadata: ReadonlyArray<MetadataRow>;
}>;

export type CallFragment = Partial<Omit<CallModel, "metadata">> &
  Readonly<{ metadata?: ReadonlyArray<MetadataRow> }>;

export type CallPart<Input> = (
  source: CallSource<Input>,
) => CallFragment | undefined;

export type ResultSource<Input, Details> = Readonly<{
  input: Partial<Input> | undefined;
  result: AgentToolResult<Details>;
  details: Details | undefined;
  options: ToolRenderResultOptions;
  isError: boolean;
}>;

export type ResultModel = Readonly<{
  output: string | undefined;
  emptyText: string | undefined;
  previewLines: number;
}>;

export type ResultFragment = Partial<ResultModel>;

export type ResultPart<Input, Details> = (
  source: ResultSource<Input, Details>,
) => ResultFragment | undefined;

export type FooterSegment = Readonly<{
  text: string;
  tone: ThemeColor;
  trailing: boolean;
}>;

export type FooterModel = Readonly<{
  segments: ReadonlyArray<FooterSegment>;
}>;

export type FooterPart<Input, Details> = (
  source: ResultSource<Input, Details>,
) => FooterSegment | ReadonlyArray<FooterSegment> | undefined;
