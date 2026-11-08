/**
 * daemon：长驻服务，持有 core，对外只暴露 protocol。
 *
 * 见 docs/0-module.md。
 */
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
