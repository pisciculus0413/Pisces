# CLI `provider list` 与 `models list`：设计

**状态：已获用户同意（短设计）。**

## 意图

`provider.list` 协议已路由（`{providers: [{id, ready, models[]}]}`，`ready` 由 daemon 凭据状态计算），但 CLI 没有入口。补齐两个只读命令，便于 `run`/`sessions` 前确认可用 provider/model。

## 目标

- `pisces provider list [--config <path>] [--data-dir <dir>] [--json]`
- `pisces models list [--provider <id>] [--config <path>] [--data-dir <dir>] [--json]`
- 两者只经协议 `provider.list`；不读本地 provider 定义、不碰凭据、不显示 `baseUrl`/`headers`。
- 失败：配置不可读 `config.invalid` 退出 2；连接失败 `daemon.unreachable` 退出 1；协议错误按码退出 1；未知 `--provider` 用 `provider.not_found` 退出 1。

## 非目标

- 不做 `providers check`、`auth`、`client.*`、`run`。
- 不新增协议方法或 daemon 行为。
- 不做模型过滤（上下文窗口/模态）；只按 provider id 过滤。

## 设计

- `provider list`：人类输出 `id  ready|unready  models=<n>`；`--json` 原样 `{providers}`。
- `models list`：人类输出 `provider/model  context=<n>  maxOutput=<n>  modalities=text,image`；`pricing` 只在 `--json` 出现。
  - 默认列出所有 provider 的模型（不按 `ready` 过滤）；空结果打印 `no models`，退出 0。
  - `--provider <id>` 只保留该 provider；id 不存在 → `provider.not_found` 退出 1。
  - `--json`：`{models: [{provider, id, contextWindow, maxOutput, modalities, pricing?}]}`。
- 复用现有短连接模式（`connectClient`、`socketPathFor`、`dataDir` 解析），不复制模板特有逻辑。
- main 解析：`provider list` 与 `models list` 两个子命令；缺子命令/未知 flag 退出 2；`--help`/`--version` 保持现状。
- 输出不回显 `baseUrl`、headers、凭据值。

## 验证

- 单测：fake client 的 `{providers}` 解析、ready 文案、models 扁平化/排序（provider 字典序、模型原序）、`--provider` 过滤、未知 provider、空列表、`--json` 形状、协议错误透传、连接失败、`--data-dir` 覆盖。
- 真实 socket：临时 daemon 注册两个 provider（一个有模型、一个空模型），`provider list`/`models list` 输出与 `--json` 正确；daemon 停止 → 1。
- 门禁 G。
