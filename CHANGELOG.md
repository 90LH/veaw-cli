# Changelog

## v0.1.0（2026-07-17）Workspace Resource Loader 闭环

### Added

- 新增 Resource Loader 基础模块：
  - Workspace discovery
  - Registry reader
  - Resource resolver
  - Resource materializer
  - Resource content reader
  - Resource lockfile
  - Workspace declarative command loader
- `init` 接入 Workspace Registry，优先安装 Workspace 资源；Workspace 不可发现时继续使用 CLI assets fallback。
- `sync` 接入 Workspace Registry 与 `.veaw/resources.lock.json`，支持新增、变更、缺失、冲突四类资源状态。
- `context` 接入 `template`、`rule` Registry，并结合项目事实生成 `.veaw/context.md`。
- `ask` 接入 `prompt`、`rule`、`skill` Registry，保持生成 AI-ready prompt 行为。
- `plan` 接入 `workflow`、`template`、`skill` Registry，保持生成 AI 实施计划输入行为。
- `catalog` 接入 `extension` / `extension-guide` / `extension-template` / `template` Registry，写入可用 Catalog 资源索引。
- 新增 `veaw commands list` 与 `veaw commands run`，用于发现和执行安全声明式 Workspace command。

### Changed

- `.veaw/config.json` 记录 Workspace 路径、Workspace 版本和 Registry schema 快照。
- `.veaw/project.json` 写入时保留旧项目已有字段和用户自定义字段。
- `.veaw/resources.lock.json` 成为 Registry 资源增量同步依据。

### Compatibility

- 保留 CLI `assets/` fallback。
- 保留旧 `.veaw` 项目初始化和重复 init/sync 能力。
- Workspace command 不允许执行 shell 或任意 JavaScript，只支持安全声明式行为。

### Verification

- `pnpm run typecheck` 通过。
- `pnpm run test` 通过，当前测试覆盖 44 个用例。
- 已使用真实 Workspace 验证 `commands list --workspace <path>` 可列出声明式 command。

### Known Gaps Before v1.0

- lockfile 尚未记录 target hash、安装状态和冲突状态。
- 缺少独立 migration 命令。
- 缺少 Registry schema 校验/修复命令。
- 资源选择策略仍偏基础，尚未按 preset/tag profile/project type 做完整选择。
