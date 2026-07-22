
# Changelog
## v0.7.0（2026-07-22）

### 修复

* 修复 Git change collector 默认包含已提交历史文件，导致 `veaw status` / `veaw refresh` 结果与当前工作区状态不一致的问题。
* 修复 `veaw status` / `veaw refresh` 将 `git-today` 提交文件混入 `changedFiles` 的问题。
* 修复当天已提交的 `.gitignore`、`opengrpc/module/rb/dragon.ts` 等历史文件影响 AI 上下文刷新的问题。

### 改进

* 优化 Git 变更收集逻辑，默认仅检测当前未提交项目变更。
* 统一 `veaw status` 与 `veaw refresh` 的 Git 变更来源：

  * working tree：

    * `git diff --name-only`

  * staged：

    * `git diff --cached --name-only`

  * untracked：

    * `git ls-files --others --exclude-standard`

* 移除 `git-today`（`git log --since="today 00:00"`）作为默认变更来源，避免历史提交污染当前项目上下文。
* 保持现有敏感路径排除、catalog/context 路由、dry-run 零写入和 refresh 写入保护逻辑不变。

### 测试

* 增加 Git 变更边界测试：

  * 未暂存修改检测。
  * 暂存修改检测。
  * 未跟踪文件检测。
  * 多来源变更合并。
  * 当天已提交文件不会进入 `changedFiles`。
  * 默认流程不会调用 `git log`。

* 验证通过：

  * `pnpm run typecheck`
  * `pnpm run lint`
  * `pnpm run test`
  * `pnpm run build`

* 测试结果：

  * `99 tests passed`
  * `0 failed`
## v0.6.0（2026-07-22）

### 修复

* 修复 Git change collector 无法识别当前工作区修改的问题。
* 修复 `veaw status` 仅返回 `git-today` 提交文件，遗漏未提交修改的问题。
* 优化 Git 变更收集逻辑，统一合并以下变更来源：

  * working tree：

    * `git diff --name-only`
  * staged：

    * `git diff --cached --name-only`
  * untracked：

    * `git ls-files --others --exclude-standard`
  * git-today：

    * `git log --since="today 00:00" --name-only --pretty=format:`

### 改进

* Git 自动检测来源统一调整为：

```text
source:
"git-auto"
```

* 新增 Git 变更来源标识：

```json
sources:
[
  "working-tree",
  "staged",
  "untracked",
  "git-today"
]
```

* 优先保证当前工作区修改被检测，提升 `veaw status` 与真实 Git 状态的一致性。

### 测试

* 新增 Git 工作区修改检测测试。

覆盖场景：

```bash
git status --short

 M src/views/permissionManagement/index.vue
```

执行：

```bash
veaw status
```

验证结果：

* 输出结果必须包含：

```text
src/views/permissionManagement/index.vue
```

### 兼容性

* 保持 `veaw status` 只读行为。
* 保持 `veaw refresh` 默认 JSON dry-run 行为。
* 不增加任何自动写入 `.veaw` 生成区的逻辑。

### 影响范围

涉及：

* Git change collector
* `veaw status`
* `veaw refresh` 数据来源分析

未改变：

* CLI 命令接口
* 写入权限模型
* dry-run 安全约束

## v0.5.0（2026-07-21）

### 新增

* 新增 `veaw refresh` 增量分析命令，用于基于项目变更生成 AI Workspace 更新摘要。
* 新增 refresh JSON Summary 输出能力，默认仅分析并返回结果，不产生任何文件写入。
* 新增 `--write-generated` 显式写入模式，仅在用户确认后更新 `.veaw` 生成区内容。
* 新增 `src/layouts` 作为组件资产分析输入目录，与现有组件扫描规则保持一致。
* 新增 `veaw status` 增量状态检查能力，用于报告当天 Git Diff 对应的待更新 catalog/context 项。

### 架构优化

* refresh 流程复用现有 catalog 扫描机制，避免重复建设组件分析逻辑。
* refresh 流程复用已有 context 生成流程，不重新设计上下文生成体系。
* 增强增量分析策略，仅处理发生变化的项目文件，避免无变更场景重复扫描。
* 优化生成区写入边界，明确区分分析阶段与写入阶段。

### 安全与稳定性

* `veaw refresh` 默认进入只读模式，保证执行过程零文件修改。

* 新增 dry-run 零写入验证机制，通过执行前后文件快照确认无副作用。

* 禁止 refresh/status 流程修改：

  * `project.json` 自定义字段
  * 用户已有配置内容
  * init/sync/migrate 相关数据
  * lockfile 文件

* 增强敏感目录排除策略：

  * `.env*`
  * 密钥文件
  * 证书文件
  * `.git`
  * `node_modules`
  * `dist`
  * VEAW 生成目录

### 命令行为调整

#### `veaw refresh`

默认行为：

```bash
veaw refresh
```

仅输出：

* 变更文件摘要
* 待更新 catalog 项
* 待更新 context 项
* 增量分析结果

不会：

* 修改 `.veaw`
* 更新 catalog
* 更新 context
* 覆盖用户内容

写入模式：

```bash
veaw refresh --write-generated
```

允许：

* 更新 `.veaw` 生成区
* 写入 refresh 产生的生成结果

### `veaw status`

新增：

* 基于当天 Git Diff 判断待同步内容。
* 输出 catalog/context 待更新状态。
* 保持只读行为，不产生任何文件修改。

### 测试

新增：

* refresh 命令测试覆盖。
* dry-run 零写入验证测试。
* `--write-generated` 写入边界测试。
* 增量扫描行为测试。

验证：

* typecheck ✅
* lint ✅
* test ✅
* build ✅

### 变更范围

本版本严格限制修改范围：

* `src/commands/refresh.ts`
* `src/index.ts`
* `src/commands/catalog.ts`
* `tests/refresh.test.ts`

以及必要的共享类型/工具文件。

未涉及：

* init 流程
* sync 流程
* migrate 流程
* lockfile 管理
* 用户配置覆盖逻辑

### 风险与后续规划

当前版本完成基础增量刷新能力，仍存在以下演进方向：

* 增量分析缓存机制。
* 更细粒度的组件资产影响分析。
* Agent 调度层与 refresh/status 的联动。
* 多项目 Workspace 状态聚合。
* AI Context 自动优化策略。

---

## v0.3.0（2026-07-15）

### 新增

* 新增 Component Asset Analysis Agent。
* 新增 Component Analysis Skill。
* 新增组件智能工作流。
* 新增组件资产识别、分类、接口摘要、引用关系分析能力。

### 优化

* Codex Agent Router 增加组件资产分析任务路由。
* Shared Skill Index 增加 component-analysis。
* 完善 AI Frontend Workspace 组件智能化能力。

---

## v0.2.0（2026-07-14）

### 新增

* 新增 VEAW Workspace 初始化能力。
* 新增 `.veaw` 工作空间结构生成。
* 新增 project/context/session 基础上下文管理。

### 命令

新增：

```bash
veaw init
veaw doctor
veaw version
```

---

## v0.1.0（2026-07-13）

### 初始版本

* 初始化 VEAW CLI 项目。
* 支持 TypeScript CLI 架构。
* 集成 Commander、Inquirer、Chalk、Ora、fs-extra、execa。
* 支持 pnpm + Node.js 20 开发环境。

# v0.4.0（2026-07-21）

## ✨ 新增（Added）
进入 VEAW 第二阶段开发：构建可组合、可降级、无外部 AI 强依赖的研发上下文能力，并新增“基于 UI 截图调用公司内部组件库 MCP”能力。

总约束：

- 先阅读现有 CLI、测试、Workspace 资源、第一阶段 schema 与资源注册机制。
- TypeScript strict，禁止 any，最小化修改；默认 stdout-only，所有写入必须显式指定。
- 不自动上传截图、访问令牌或内部组件数据；不写入 git。
- MCP 不可用、鉴权失败、截图缺失或查询无结果时必须降级，不阻塞主流程。
- 不得虚构组件 API、项目约定或 MCP 工具能力；不确定项须明确标注。

实现顺序：

1. 定义共享 schema 与资源注册

- 定义 `screenshot-context`、`component-query-result`、`ui-component-context`、`design-context`、`task-list`、`review-result` 的机器可读 schema。
- 保持 Workspace resources、CLI assets fallback 与旧版 `.veaw` 兼容。

2. UI 截图上下文

- 只读取用户显式提供的截图或本地测试截图。
- 记录截图路径/引用、页面或路由、视口、采集时间、关联组件、来源和权限状态。
- 截图缺失时输出空上下文及降级原因，不中断 ask、plan、task generator。

3. 本地组件查询 fallback

- 基于 component catalog 查询组件名称、Props、Emits、Slots、示例、分类、依赖、使用场景。
- 查询结果必须带来源证据；MCP 不可用时作为稳定 fallback。

4. 公司内部组件库 MCP

- 先确认真实 MCP 协议、鉴权、资源注册、工具 schema、调用限制和数据安全边界。
- 新增 MCP adapter，仅在配置存在且用户显式启用时调用。
- 输入：截图上下文、可选页面需求、本地 catalog 查询结果。
- 从截图中仅提取可观察的结构信息：布局、控件类型、层级、状态、尺寸/间距特征；每项附置信度和截图证据。
- 调用内部 MCP 查询候选组件、Props、Emits、Slots、设计 token、示例、依赖和适配约束。
- 合并 MCP 与本地 catalog 结果：优先推荐项目已有组件，内部库作为补充；去重并保留来源。
- 输出 `ui-component-context`：截图证据、候选组件、匹配理由、API、风险、不确定项、替代方案。
- MCP 失败时仅使用本地 catalog，并输出明确的降级原因；不得暴露 token 或内部敏感内容。

5. design-context

- 输入需求、已有路由/组件、截图上下文、组件查询结果。
- 输出布局结构、交互状态、响应式要求、组件复用建议、设计约束和不确定项。
- 不绕过现有 Naive UI 与项目组件体系；内容必须机器可读并可供 ask、plan、task generator 使用。

6. task generator

- 输入实施计划和 design-context。
- 输出有序任务：目标、涉及文件、依赖、验证方式、完成定义、风险。
- 默认 stdout；只有 `--output` 才允许写文件。

7. review

- 校验：引用文件存在性、组件 API 与 catalog/MCP 证据一致性、路由/store/service 约定、无 any、无虚构依赖、无未授权写入、最小改动原则。
- 输出 findings、证据、严重等级、最小修复建议；无问题时说明残余风险与测试缺口。

验证：

- 为 MCP adapter 提供 mock 测试：成功、未配置、鉴权失败、超时、空结果、截图缺失、与本地 catalog 冲突。
- 验证默认命令不创建文件；显式输出才写入。
- 使用 soybean-admin 做只读端到端验收，不刷新或修改其 `.veaw`，不产生残留。
- 完成后报告修改文件、schema、命令结果、兼容性和待人工确认的信息。

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
