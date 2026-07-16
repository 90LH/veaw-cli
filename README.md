# VEAW CLI

> VEAW 是一个面向 AI 辅助开发的项目上下文工作区工具。它会在项目内维护 `.veaw` 工作区，沉淀项目画像、组件目录、长期上下文、实施计划提示词和 AI 开发会话记录。

## 特性

- 初始化 `.veaw` 工作区，保留项目长期上下文。
- 同步项目技术栈、package.json、TypeScript、Vite、Git 等元信息。
- 扫描 Vue/TSX/JSX 组件，生成组件目录和依赖关系。
- 生成 AI-ready prompt，用于向 AI 提问或制定实施计划。
- 管理 AI 开发会话记录，方便跨轮次交接和回溯。
- 不调用第三方 AI API，只生成可复制给 AI 的上下文材料。

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript | 开发语言 |
| Commander | CLI 命令解析 |
| Inquirer | 命令交互 |
| Chalk | 日志输出 |
| Ora | Loading 动画 |
| fs-extra | 文件操作 |
| execa | 子进程执行 |
| zx | Shell 自动化 |
| tsup | 打包 |

## 环境要求

| 软件 | 版本 |
|------|------|
| Node.js | >=20 |
| pnpm | >=10 |

检查版本：

```bash
node -v
pnpm -v
```

## 本仓库开发

```bash
pnpm install
```

开发模式运行 CLI：

```bash
pnpm dev -- --help
pnpm dev -- init
pnpm dev -- sync
pnpm dev -- catalog
pnpm dev -- context
pnpm dev -- ask "如何理解这个项目？"
pnpm dev -- plan "新增一个用户设置页面"
pnpm dev -- session start "实现用户设置页面"
pnpm dev -- doctor
pnpm dev -- version
```

开发模式无需打包即可验证 CLI。

## 构建

```bash
pnpm build
```

默认使用 **tsup** 打包，产物输出到 `dist/`。

## 新项目接入手册

在需要接入 VEAW 的项目根目录执行以下命令。

### 1. 初始化工作区

```bash
veaw init
```

会创建 `.veaw` 工作区，包含：

```text
.veaw/
├── assets/
├── component-catalog/
├── config/
├── prompts/
├── templates/
├── context.md
├── project.json
└── session-log.md
```

### 2. 同步项目画像

```bash
veaw sync
```

生成或刷新 `.veaw/project.json`，记录项目名称、技术栈、包管理器、TypeScript/Vite 配置、Git 分支和 commit 等信息。

### 3. 生成组件目录

```bash
veaw catalog
```

扫描以下目录中的 `.vue`、`.tsx`、`.jsx` 组件：

```text
src/components
src/views
src/layouts
```

输出到 `.veaw/component-catalog/catalog.json`，包含组件名称、文件路径、Props、Emits、Slots 和依赖关系。

### 4. 生成长期上下文

```bash
veaw context
```

根据 `project.json` 和组件目录更新 `.veaw/context.md` 的自动生成区域。自动区域外的手写内容会保留，适合记录业务背景、架构决策和团队规范。

### 5. 开始 AI 开发会话

```bash
veaw session start "实现课程详情页"
```

开发过程中追加关键记录：

```bash
veaw session log "已确认页面复用 src/components/CourseList。"
```

结束会话并写入总结：

```bash
veaw session end "课程详情页实现完成，已通过 typecheck 和 build。"
```

查看历史摘要：

```bash
veaw session list
```

### 6. 生成可复制给 AI 的上下文

问答场景：

```bash
veaw ask "这个项目新增页面应该放在哪个目录？"
```

写出到文件：

```bash
veaw ask "分析课程组件依赖" --output .veaw/prompts/course-analysis.md
```

实施计划场景：

```bash
veaw plan "新增课程详情页"
```

默认写入 `.veaw/plans/<timestamp>-plan.md`。只预览不写文件：

```bash
veaw plan "新增课程详情页" --dry-run
```

指定输出路径：

```bash
veaw plan "新增课程详情页" --output .veaw/plans/course-detail-plan.md
```

### 推荐日常流程

```bash
veaw sync
veaw catalog
veaw context
veaw session start "本次开发主题"
veaw plan "本次开发需求"
veaw ask "需要 AI 协助的问题"
veaw session log "关键进展或决策"
veaw session end "本次开发总结"
```

当依赖、路由、组件或目录结构发生明显变化时，重新执行 `veaw sync`、`veaw catalog`、`veaw context`。

## CLI 命令

| 命令 | 说明 |
|------|------|
| `veaw init` | 初始化 `.veaw` 工作区 |
| `veaw sync` | 同步项目元信息到 `.veaw/project.json` |
| `veaw catalog` | 扫描组件并生成 `.veaw/component-catalog/catalog.json` |
| `veaw context` | 生成或刷新 `.veaw/context.md` 自动上下文 |
| `veaw ask <question>` | 生成 AI-ready 项目上下文提示词 |
| `veaw ask <question> --output <file>` | 将问答提示词写入文件 |
| `veaw plan <requirement>` | 生成 AI 实施计划提示词模板 |
| `veaw plan <requirement> --dry-run` | 只输出计划模板，不写文件 |
| `veaw plan <requirement> --output <file>` | 将计划模板写到指定文件 |
| `veaw session start <title>` | 开始 AI 开发会话 |
| `veaw session log <content>` | 向当前会话追加记录 |
| `veaw session end [summary]` | 结束当前会话并写入可选总结 |
| `veaw session list` | 输出历史会话摘要 |
| `veaw doctor` | 检查本地开发环境 |
| `veaw version` | 输出 CLI 版本 |

## Scripts

| Script | 说明 |
|---------|------|
| pnpm dev | 开发模式运行 CLI |
| pnpm build | 打包 CLI |
| pnpm lint | ESLint 检查 |
| pnpm test | 运行测试 |
| pnpm typecheck | TypeScript 类型检查 |
| pnpm prepare | 发布前自动构建 |

## 推荐开发流程

```text
开发
  │
  ▼
pnpm dev
  │
  ▼
功能验证
  │
  ▼
pnpm lint
  │
  ▼
pnpm typecheck
  │
  ▼
pnpm build
  │
  ▼
npm publish
```

## 推荐目录结构

```text
src/
├── commands/
├── core/
├── services/
├── utils/
├── constants/
├── types/
├── config/
├── templates/
└── index.ts
```

## 开发规范

- TypeScript Strict Mode
- ESLint
- Prettier
- Conventional Commits
- Git Flow（或团队规范）

## AI Coding 建议

- 新命令统一放入 `commands/`
- 公共逻辑放入 `core/` 或 `services/`
- 保持单一职责
- 优先复用已有实现
- 避免重复造轮子
- 保持命令接口兼容

## Roadmap

- [ ] create
- [ ] add
- [ ] doctor
- [ ] update
- [ ] plugin
- [ ] config
- [ ] init template marketplace

## License

MIT
