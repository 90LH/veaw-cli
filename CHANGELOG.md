# Changelog

# v0.3.0（2026-07-21）

## ✨ 新增（Added）

### ask 命令增强

- 新增 `veaw ask --answer` 模式，用于生成结构化项目分析结果。
- 保留原有 AI Prompt 生成功能，并调整为显式 `--prompt` 模式，避免命令语义歧义。
- `--answer` 输出统一包含：
  - 结论
  - 证据来源
  - 缺失上下文
  - 保守建议

- 无外部 AI 能力时，自动降级为可直接提交给 AI 的回答任务，不伪装为模型推理结果。

### plan 命令增强

- 默认改为 stdout 输出。
- 新增 `--output <file>` 指定输出文件。
- 输出文件存在时拒绝覆盖。
- 默认及 `--dry-run` 模式均不会创建 `.veaw/plans` 或任何目录。
- 生成内容升级为可执行实施计划，包括：
  - 推荐修改文件
  - 路由、状态、Service 与组件复用建议
  - 实施步骤
  - 验证命令
  - 风险分析
  - 验收标准
  - 上下文缺失项

### Component Catalog

- 新增稳定元数据：
  - `componentKind`
  - `category`
  - `isShared`
  - `usageHints`
  - 语义化内部依赖
  - 可选 `callers` / `usedBy`

- 保持旧版 Catalog Schema 完全兼容。

### Context Generator

- 自动检测内容与人工维护内容正式分离。
- 新增稳定维护模板：
  - Architecture
  - Conventions
  - Decisions
  - Routing
  - Service
  - Store
  - Permission
  - Composable
  - Component Boundary
  - i18n
  - Error Handling
  - Testing

## 🔧 改进（Changed）

### ask

- 明确 Prompt 与 Answer 两种职责。
- 改善帮助信息与命令说明。
- 保持旧版调用方式兼容。

### plan

- 默认行为改为完全非破坏性。
- stdout 成为默认输出方式。
- `--dry-run` 与默认行为保持一致。

### Catalog Scanner

- 修正 Vue SFC 名称识别策略。
- 避免普通常量、CSS 常量及导入标识符被识别为组件名。
- 优化 Props、Emits、Slots 提取逻辑。
- 避免 URL、字符串、注释及无关标识符误识别。

### Context Generation

- 区分：
  - 自动检测事实
  - 已确认项目约定
  - 待维护者确认

- 禁止将推断结果写入已确认内容。

## 🧪 测试（Tests）

新增或完善：

- ask 新旧模式兼容测试
- plan stdout 行为测试
- plan `--output` 写入测试
- dry-run 无文件写入测试
- Catalog 回归测试
- Context Generator 回归测试
- Directory Snapshot 测试
- Schema 兼容性测试

## 🔒 兼容性（Compatibility）

- 保持旧版 `.veaw` 项目兼容。
- 保持 CLI Assets Fallback 兼容。
- 保持 `project.json` 自定义字段兼容。
- 保持 Catalog JSON 消费方兼容。
- 默认行为全部调整为非破坏性。

## 🚀 为下一阶段准备

完成研发上下文能力基础，为以下能力提供接入点：

- UI Screenshot Context
- Component MCP
- Design Context
- Task Generator
- Review Pipeline
- Shared Context Schema

## v0.2.0（2026-07-20）

### ✨ 新增（Added）

#### VEAW Workspace 完整初始化

`veaw init` 现在能够完整初始化项目工作区。

新增默认生成：

- `.veaw/config.json`
- `.veaw/resources.lock.json`
- `.veaw/commands/`

保持增量初始化策略：

- 已存在文件默认不覆盖
- 保留用户已有：
  - `project.json`
  - `context.md`
  - `session-log.md`
  - `component-catalog/`
  - 用户备注与自定义内容

---

#### Resource Lock（资源同步状态）

新增 `resources.lock.json`。

用于记录 Workspace Registry 同步状态。

支持记录：

- prompts
- templates
- agents
- skills
- config
- sourcePath
- targetPath
- version
- hash
- synchronizedAt

为后续：

- registry doctor
- audit
- sync
- migrate

提供统一资源状态。

---

#### Commands Workspace

初始化时自动创建：

```
.veaw/commands/
```

用于保存：

- command presets
- workflow commands
- project command assets

为后续：

- warm-start
- ask
- plan
- review

提供统一入口。

---

### 🚀 改进（Improved）

#### veaw sync

同步逻辑升级。

现在支持：

- 增量更新 `.veaw/project.json`
- 更新 `resources.lock.json`
- 保留用户自定义字段
- 不覆盖其它 `.veaw` 文件
- 不删除用户内容

同步结果更加适合长期维护。

---

#### veaw context

Context 自动生成能力增强。

自动识别并输出：

- 技术栈
- UI Library
- Router
- State Management
- API / Service Directory
- Components Directory
- Layout Directory

支持从：

- package.json
- 项目目录
- project.json

推断项目上下文。

自动生成区域仅更新受管理内容。

用户手写内容继续保留。

---

#### Context 可读性提升

生成的 `context.md` 现在能够帮助 AI 更准确理解：

- 项目结构
- 技术栈
- 目录职责
- 开发约束
- 组件组织方式

为后续：

- veaw ask
- veaw plan
- design-context
- review

提供稳定上下文。

---

### 🛠 工程改进（Engineering）

新增统一 Resource Lock TypeScript 类型。

资源模型支持：

- 来源
- 路径
- 校验信息
- 同步时间
- Registry 状态

统一使用：

- `fs-extra`
- `process.cwd()`

所有新增代码遵循：

- TypeScript strict
- 无 any
- 明确返回类型
- TSDoc
- Commander 风格
- logger 风格
- 最小化修改原则

---

### 🐞 修复（Fixed）

修复真实项目 `soybean-admin` 初始化后 Workspace 不完整的问题。

修复内容包括：

- 缺少 `.veaw/config.json`
- 缺少 `.veaw/resources.lock.json`
- 缺少 `.veaw/commands/`
- `context.md` 缺少关键项目上下文
- `sync` 未维护资源状态

---

### 🔒 保持兼容（Compatibility）

保持以下行为不变：

- Catalog 增量更新
- 用户备注保留
- Component Catalog 不覆盖
- Session Log 不覆盖
- Context 用户手写内容保留
- Project 自定义字段保留

保证旧项目可安全升级。

---

### ✅ 验证（Verification）

完成以下验证：

- Workspace 初始化验证
- Resource Lock 验证
- Project Context 验证
- Catalog 保留验证
- 增量 Sync 验证
- TypeScript 类型检查
- Build 验证
- Lint 验证

真实项目：

```
D:\test-project\soybean-admin
```

推荐重新执行：

```bash
veaw init
veaw sync
veaw context
```

完成 Workspace 补齐。

---

### 📌 下一阶段（Planned）

下一阶段将进入 AI Context Pipeline：

- `veaw design`
- `veaw ask`
- `veaw plan`
- `veaw review`
- Design Context
- Task Generator
- Runtime Context
- Review Pipeline

进一步实现完整的 AI Frontend Engineering Workflow。

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
