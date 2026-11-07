/**
 * daemon：长驻服务，持有 core，对外只暴露 protocol。
 *
 * 见 docs/0-module.md。
 */
export {
  createSessionStore,
  type RecoveryIssue,
  type SessionStore,
  type SessionStoreOptions,
} from "./session-store/session-store.js";
