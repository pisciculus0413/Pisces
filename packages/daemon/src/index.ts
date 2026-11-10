/**
 * daemon：长驻服务，持有 core，对外只暴露 protocol。
 */

export type { ProtocolEvent } from "@pisces/protocol";
export {
  type ConfigScope,
  mergeConfigLayers,
  parseExtensionConfig,
  parseExtensionConfigText,
  readConfigLayer,
  readGlobalConfig,
  readWorkspaceConfig,
} from "./extensions/config.js";
export {
  defaultBuiltinDir,
  discoverExtensions,
  listExtensions,
} from "./extensions/discovery.js";
export type {
  DiscoveredEntry,
  ExtensionBinding,
  ExtensionConfig,
  ExtensionIssue,
  ExtensionListing,
  ExtensionListingEntry,
  ExtensionOrigin,
  Extensions,
  ExtensionsOptions,
  ListExtensionsOptions,
} from "./extensions/types.js";
export {
  type ActiveTurnMarker,
  type ActiveTurnStore,
  createActiveTurnStore,
} from "./gateway/active-turn.js";
export { type BootstrapResult, bootstrapGateway } from "./gateway/bootstrap.js";
export { createGateway, type Gateway, type GatewayDeps } from "./gateway/gateway.js";
export type * from "./gateway/protocol.js";
export { type RecoveryDeps, recoverActiveTurns } from "./gateway/recovery.js";
export {
  type DaemonHost,
  type DaemonHostStatus,
  type StartDaemonOptions,
  startDaemon,
} from "./host/daemon-host.js";
export {
  createProviderHost,
  type ProviderHost,
  type ProviderHostOptions,
} from "./provider/provider-host.js";
export {
  type ActiveTurn,
  type Concurrency,
  type ConcurrencyOptions,
  createConcurrency,
} from "./runtime/concurrency.js";
export { createEventBus } from "./runtime/event-bus.js";
export { createSessionEventClock } from "./runtime/event-clock.js";
export {
  createSessionStore,
  type RecoveryIssue,
  type SessionStore,
  type SessionStoreOptions,
} from "./session-store/session-store.js";
