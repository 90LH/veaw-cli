# VEAW CLI

> 🚀 一个基于 **TypeScript** 构建的现代化 Node.js CLI 开发脚手架，集成命令解析、交互式终端、日志输出、构建打包及工程化能力，帮助快速开发企业级 CLI 工具。

## ✨ 特性

- ⚡ 基于 TypeScript 开发
- 📦 使用 pnpm 管理依赖
- 🚀 使用 tsup 打包
- 🎨 Chalk 彩色终端输出
- 💬 Inquirer 交互式命令
- ⏳ Ora Loading 动画
- 📁 fs-extra 文件操作
- 🖥️ execa 子进程执行
- 📝 zx Shell 自动化
- 🔧 Commander 命令管理
- 🏗️ 企业级目录结构
- 🤖 AI Coding 友好

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

## 安装

```bash
pnpm install
```

## 开发

```bash
pnpm dev -- --help
pnpm dev -- init
pnpm dev -- doctor
pnpm dev -- version
```

开发模式无需打包即可验证 CLI。

## 构建

```bash
pnpm build
```

默认使用 **tsup** 打包，产物输出到 `dist/`。

## CLI 命令

```bash
veaw init
veaw doctor
veaw version
```

## Scripts

| Script | 说明 |
|---------|------|
| pnpm dev | 开发模式运行 CLI |
| pnpm build | 打包 CLI |
| pnpm lint | ESLint 检查 |
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
