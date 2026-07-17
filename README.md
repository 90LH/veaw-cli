# VEAW CLI

VEAW CLI 是 `Workspace -> Resource Loader -> CLI -> Project` 架构中的命令行层。它负责发现 Workspace、读取 Registry、安装资源到项目 `.veaw/`，并为 AI 生成上下文、prompt、计划和声明式命令输入。

CLI 不直接调用第三方 AI Provider。`ask`、`plan`、Workspace command 当前都只生成 AI-ready 输入。

## Architecture

```text
veaw Workspace
  -> registries/*.json
  -> Resource Loader
  -> built-in CLI commands
  -> project/.veaw
```

Workspace 不可发现时，CLI 会回退到内置 `assets/`，保证旧项目仍可初始化。

## Resource Loader

Resource Loader 当前提供：

- Workspace discovery：`--workspace`、`VEAW_WORKSPACE`、项目 `.veaw/config.json`、向上查找、CLI assets fallback。
- Registry reader：读取顶层 registry 和子 registry，校验 schema version、resource sourcePath。
- Resource resolver：按 id、type、tag 和 dependencies 解析资源。
- Materializer：支持 `copy`、`reference`、`render`、`none`。
- Lockfile：读写 `.veaw/resources.lock.json`。
- Workspace command loader：读取和执行安全声明式 command。

## Commands

| Command | 职责 |
|---------|------|
| `veaw init [--workspace <path>]` | 初始化项目 `.veaw/`，优先从 Workspace Registry 安装资源，无法发现 Workspace 时使用 CLI assets fallback |
| `veaw sync [--workspace <path>]` | 比较 Registry 与 `resources.lock.json`，增量同步新增、变更、缺失、冲突资源，并刷新项目画像 |
| `veaw catalog` | 扫描组件目录，并从 extension/template Registry 写入可用 Catalog 资源索引 |
| `veaw context` | 从 template/rule Registry、`project.json` 和 component catalog 生成长期上下文 |
| `veaw ask <question>` | 从 prompt/rule/skill Registry 和项目事实组装 AI-ready prompt |
| `veaw plan <requirement>` | 从 workflow/template/skill Registry 和项目事实生成实施计划输入 |
| `veaw commands list [--workspace <path>]` | 列出 Workspace 声明式 command |
| `veaw commands run <command> key=value` | 解析参数并执行安全声明式 Workspace command |
| `veaw session ...` | 管理 `.veaw/session-log.md` 会话记录 |
| `veaw doctor` | 检查本地环境 |
| `veaw version` | 输出 CLI 版本 |

## Built-in vs Workspace Commands

内置 TypeScript command 负责稳定的 CLI 行为：

- 文件创建和更新
- Registry 读取和物化
- 项目事实扫描
- lockfile 增量同步
- 参数校验和错误处理

Workspace 声明式 command 负责产品级 AI 工作流入口：

- command 名称、描述和参数 schema
- 依赖资源
- 安全 execution 类型
- 生成 AI-ready 输入

Workspace command 不允许执行任意 shell 或任意 JavaScript。

当前支持的声明式 execution：

- `generate-prompt`
- `render-template`
- `call-workflow`

## Quick Start

在用户项目根目录执行：

```bash
veaw init --workspace D:\test-project\AI-Workspace\veaw
veaw sync
veaw catalog
veaw context
veaw ask "如何新增一个列表页？"
veaw plan "新增用户管理页面"
veaw commands list
veaw commands run new-page page_name=UserList route_path=/users description="用户列表页"
```

无 Workspace 时仍可初始化：

```bash
veaw init
```

这会使用 CLI 内置 `assets/` 创建兼容的 `.veaw/`。

## Project Files

CLI 会维护：

```text
.veaw/
├── assets/                         # fallback assets
├── component-catalog/catalog.json
├── config.json                     # workspace/config snapshot
├── context.md
├── project.json                    # project facts, custom fields preserved
├── resources.lock.json             # installed registry resources
├── session-log.md
└── resources/                      # materialized Workspace resources
```

## Compatibility

- 旧 `.veaw/project.json` 自定义字段会保留。
- 旧项目没有 `resources.lock.json` 时，`init` / `sync` 可迁移。
- Workspace 丢失时，`sync` 会提示并跳过资源同步，不破坏旧项目。
- CLI `assets/` fallback 未移除。

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

开发模式：

```bash
pnpm run dev -- commands list --workspace D:\test-project\AI-Workspace\veaw
```

## Test Coverage

当前测试覆盖：

- Workspace discovery 与 fallback
- Registry schema 版本错误
- dependency resolver
- materializer / lockfile
- init Workspace 初始化、fallback 初始化、旧项目字段保留、幂等性
- sync 增量、冲突、Workspace 版本变化、旧项目迁移、Workspace 丢失
- context / ask / plan / catalog 消费 Registry 资源
- Workspace commands list/run、未知 command、参数非法、资源缺失、版本不兼容

## v1.0 前仍需完成

- 更完整的资源安装状态模型：target hash、安装状态、冲突状态。
- Project migration 命令，覆盖更多旧项目路径。
- Registry schema 校验命令和修复建议。
- 更细的资源选择策略：preset、tag profile、项目类型。
- 声明式 command 的输出路径和 workflow 编排能力增强，但仍保持安全边界。

## License

MIT
