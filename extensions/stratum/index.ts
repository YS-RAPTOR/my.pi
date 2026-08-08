import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { Broker } from "./broker/index.ts";
export { Activity } from "./capabilities/activity/index.ts";
export { Shell } from "./capabilities/shell/index.ts";
export { Client } from "./client/index.ts";
export { Connection } from "./common/connection.ts";
export { Session } from "./common/session.ts";
export { Config } from "./config/index.ts";

const Stratum = (_pi: ExtensionAPI): void => {};

export default Stratum;
