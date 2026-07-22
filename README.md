# VEAW CLI

> Vue Enterprise AI Workspace CLI
> 面向企业级 Vue 项目的 AI 工程上下文基础设施。

VEAW CLI 是 `Workspace -> Resource Loader -> CLI -> Project` 架构中的命令行层。

它负责：

* 发现和加载 AI Workspace
* 读取 Registry 资源
* 安装资源到项目 `.veaw/`
* 分析项目结构与组件体系
* 生成 AI 可理解的项目上下文
* 为 AI 提供 prompt、plan、workflow 输入

VEAW CLI **不直接调用第三方 AI Provider**。

`ask`、`plan`、Workspace command 当前只负责生成 AI-ready 输入，由用户交给：

* ChatGPT
* Claude
* Codex
* DeepSeek
* Kimi
* 其他 AI 工具

执行。

---

# Architecture

```text
                    AI Workspace

              registries/*.json
                     |
                     v
              Resource Loader
                     |
                     v
              VEAW CLI Commands
                     |
                     v
                  Project

                  .veaw/
        ┌────────────────────────┐
        │ project.json           │
        │ context.md             │
        │ component-catalog      │
        │ resources.lock.json    │
        │ session-log.md         │
        └────────────────────────┘
                     |
                     v

              AI-ready Context
```

---

# Core Design

## AI Provider 无关

VEAW 不负责：

* 调用模型 API
* 管理 API Key
* 绑定 AI 平台

VEAW 只负责：

> 将企业项目知识转换为 AI 可以消费的上下文。

---

## 项目优先

所有上下文来源于：

* 真实代码
* 项目配置
* Git 状态
* 组件结构
* Workspace 资源

而不是人工维护文档。

---

## 最小侵入

VEAW：

* 不修改业务代码
* 不改变项目目录
* 不接管开发流程

只维护：

```text
.veaw/
```

目录。

---

# Resource Loader

Resource Loader 是 VEAW 的核心资源解析层。

当前能力：

## Workspace Discovery

支持：

优先级：

1. `--workspace`
2. `VEAW_WORKSPACE`
3. 项目 `.veaw/config.json`
4. 父级目录向上查找
5. CLI 内置 `assets/` fallback

当 Workspace 不可发现时：

自动降级到 CLI 内置资源。

保证旧项目仍可以初始化。

---

## Registry Reader

支持：

* 顶层 Registry
* 子 Registry
* schema version 校验
* sourcePath 校验

---

## Resource Resolver

支持：

* id
* type
* tag
* dependencies

解析资源依赖关系。

---

## Materializer

支持资源落地方式：

* `copy`
* `reference`
* `render`
* `none`

---

## Lockfile

维护：

```text
.veaw/resources.lock.json
```

记录：

* 已安装资源
* 版本
* hash
* 来源
* 状态

支持增量同步。

---

# Commands

| Command              | 职责                         |
| -------------------- | -------------------------- |
| `veaw init`          | 初始化项目 `.veaw/`             |
| `veaw sync`          | 增量同步 Workspace Registry 资源 |
| `veaw catalog`       | 扫描项目组件并生成组件索引              |
| `veaw context`       | 生成 AI 项目上下文                |
| `veaw status`        | 分析当前项目变化                   |
| `veaw refresh`       | 根据代码变化刷新 AI 状态             |
| `veaw ask`           | 生成 AI-ready 问题上下文          |
| `veaw plan`          | 根据需求生成实施计划输入               |
| `veaw commands list` | 查看 Workspace command       |
| `veaw commands run`  | 执行安全声明式 command            |
| `veaw session`       | 管理 AI 会话记录                 |
| `veaw doctor`        | 环境检查                       |
| `veaw version`       | 输出版本                       |

---

# Project Intelligence

## Component Catalog

命令：

```bash
veaw catalog
```

生成：

```text
.veaw/component-catalog/catalog.json
```

用于描述：

* 公共组件
* 页面组件
* 布局组件
* 业务模块

支持：

* 全量扫描
* 增量刷新
* 删除同步
* 用户字段保留

---

## Project Context

命令：

```bash
veaw context
```

生成：

```text
.veaw/context.md
```

包含：

* 技术栈
* 项目结构
* 路由
* 状态管理
* UI 框架
* API 约定
* 组件体系

供 AI 理解项目。

---

## Git Change Awareness

命令：

```bash
veaw status
```

分析：

* working tree
* staged files
* untracked files

用于：

* 精确刷新上下文
* 避免 AI 获取过时信息

---

## Refresh Workflow

命令：

```bash
veaw refresh
```

流程：

```text
Git Changes

    |
    v

Component Update

    |
    v

Catalog Refresh

    |
    v

Context Refresh

    |
    v

AI Context Updated
```

特点：

* 不覆盖用户修改
* 内容无变化不写入
* 支持删除和重命名同步

---

# Built-in vs Workspace Commands

## Built-in Commands

TypeScript 实现。

负责：

* 文件操作
* Registry 解析
* 项目扫描
* lockfile 管理
* 参数校验

---

## Workspace Commands

声明式 AI 工作流入口。

负责：

* command 描述
* 参数 schema
* 资源依赖
* AI 输入生成

禁止：

* 任意 shell 执行
* 任意 JavaScript 执行

当前 execution：

* `generate-prompt`
* `render-template`
* `call-workflow`

---

# Quick Start

进入 Vue 项目：

```bash
cd your-project
```

初始化：

```bash
veaw init
```

指定 Workspace：

```bash
veaw init --workspace D:\AI-Workspace\veaw
```

生成上下文：

```bash
veaw catalog

veaw context
```

查看变化：

```bash
veaw status
```

刷新：

```bash
veaw refresh
```

生成 AI 输入：

```bash
veaw ask "如何新增一个列表页？"

veaw plan "新增用户管理页面"
```

---

# Project Files

```text
.veaw/

├── assets/
│
├── component-catalog/
│   └── catalog.json
│
├── config.json
│
├── project.json
│
├── context.md
│
├── resources.lock.json
│
├── session-log.md
│
└── resources/
```

---

# Compatibility

支持：

* 保留旧项目 `.veaw/project.json` 自定义字段
* 无 lockfile 项目迁移
* Workspace 丢失 fallback
* CLI assets fallback

---

# Development

安装：

```bash
pnpm install
```

验证：

```bash
pnpm run typecheck

pnpm run test

pnpm run build
```

开发：

```bash
pnpm run dev -- commands list --workspace ./workspace
```

---

# Test Coverage

当前覆盖：

## Workspace

* discovery
* fallback
* registry 校验

## Resource System

* resolver
* dependency
* materializer
* lockfile

## Project

* init
* sync
* migration
* catalog
* context
* refresh

## AI Workflow

* ask
* plan
* session
* workspace command

---

# Current Status

## 已实现

✅ Workspace 架构
✅ Registry 系统
✅ Resource Loader
✅ CLI 初始化
✅ 项目上下文生成
✅ Component Catalog
✅ Git 状态分析
✅ Refresh 工作流
✅ AI-ready Prompt
✅ 声明式 Command

---

# v1.0 前规划

* 更完整资源安装状态模型
* Project migration 工具
* Registry 自动修复建议
* preset/profile 资源组合
* 更强 workflow 编排能力

暂不包含：

* AI Agent 自动执行
* MCP Provider 调度
* 自动代码修改系统

---

# License

MIT
