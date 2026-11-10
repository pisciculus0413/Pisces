# CLI 扩展装配：设计（修订）

**状态：用户确认按“只传 configPath、prepare 时读取并扫描”继续。**

## 意图

让 `pisces start` 启动的 daemon 进入目录驱动扩展模式，使 `run --enable`、默认 `extensions`、`entryConfig`、工作区扩展与内置 shell tool 真正可用。启动只传配置位置，不在启动时读取配置或扫描扩展目录。

## 读取时机（与 HLD §6.6/§7.2 一致）

- 启动：CLI 传 `extensions: { configPath }`（以及仍独立的 `templatesDir`），不传 `defaults`、`defaultWorkspace`、扩展解析结果。
- 每次 `session.create` / 绑定准备：daemon `prepare(workspace)` 才读取
  - `<dirname(configPath)>/config.json`（实际是 `configPath` 指向的任意文件）；
  - `<workspace>/.pisces/config.json`；
  - 扫描 `<dirname(configPath)>/extensions/` 与 `<workspace>/.pisces/extensions/`；
  - 合并 `defaults`/`defaultWorkspace`/`extensions`/`entryConfig` 并冻结绑定。
- 因此修改配置后，**新会话无需重启 daemon** 即可生效；`provider` 注册与 `templatesDir` 仍在启动时固定。
- 启动不校验扩展配置；首次 `session.create` 才报 `config.invalid`，保持生命周期不被坏扩展配置阻塞。

## 接口

- daemon `ExtensionsOptions` 支持 `configPath?: string` 与现有 `configDir?: string`：
  - `configPath` 优先作为全局层文件；
  - 扩展目录 = `configDir ?? dirname(configPath)` + `/extensions`；
  - 至少提供一个，否则启动失败（`config.invalid`）。
- `createExtensions` 在构造时只解析位置，不读文件；`prepare` 使用 `configPath` 读取全局层。
- CLI `buildDaemonOptions` 改为接收 `configPath`（绝对化），始终设置 `extensions: { configPath }`；移除 `defaults` 注入（否则与配置模式互斥）。
- `defaults` 与 `defaultWorkspace` 完全由扩展配置层在 `session.create` 时提供；CLI 仍解析它们用于 `config`/校验。

## 非目标

- 不装配 `ClientRegistry`、`CredentialStore`、`providers`/`clients` 扩展贡献。
- 不改变内置 shell 默认关闭；启用需 `extensions` 配置或 `run --enable`。
- 不新增协议方法。

## 验证

- daemon：`configPath` 指到非 `config.json` 文件时，全局配置与扩展目录按 `dirname` 生效；`configDir` 旧路径不回归；两者都缺失败。
- CLI assembly：始终传 `extensions.configPath`，不传 `defaults`；templates 独立；绝对路径。
- 真实 socket：临时配置启用内置 shell，daemon + 本地 OpenAI 兼容 SSE 服务器；`run` 触发 shell tool 并返回命令输出；`run --enable`/默认 `extensions` 均可用；工作区 `.pisces/extensions` 可被发现。
- 配置改动后新会话立即生效（无需重启）；`--config alt.json` 精确读取。
- 文档：`docs/cli.md`、`docs/extensions.md`、HLD/DDS 同步；门禁 G。
