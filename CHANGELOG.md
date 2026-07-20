# Changelog

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
