/**
 * daemon：长驻服务，持有 core，对外只暴露 protocol。
 *
 * 见 docs/0-module.md。
 */
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
