# Saasflare Starter ⚡️

[中文](#saasflare-starter-中文)

Saasflare Starter is an opinionated **Full Stack Starter Kit** built for **Cloudflare's Edge Network**. It runs **TanStack Start** (Frontend) and **Hono** (Backend) as independent Workers connected by **End-to-End Type Safety**. Forget complex configuration, **deploy globally with a single command. Runs for $0/month.**

---

## 🚀 Key Features

- **Zero Cost**: Runs 100% on Cloudflare (Workers + D1). $0/month for most hobby/startup apps.
- **End-to-End Type Safety**: Shared Zod schemas + ORPC. Frontend calls backend like a local function.
- **Infrastructure from Code**: Powered by **Alchemy.run**. No `wrangler.toml`. Just TypeScript.
- **AI-First Workflow**: Optimized for LLMs. Includes [GEMINI.md](./GEMINI.md) context file for instant agent onboarding.
  - Prompt Example: "Read GEMINI.md, then create a todos table and expose a getTodos API."

---

## 🛠️ Tech Stack

| Category           | Technology                | Description                        |
| :----------------- | :------------------------ | :--------------------------------- |
| **Frontend**       | **TanStack Start**        | Edge-optimized React framework.    |
| **Backend**        | **Hono**                  | Ultra-fast standard web framework. |
| **Communication**  | **ORPC + TanStack Query** | E2E Type-safe RPC                  |
| **Database**       | **Cloudflare D1/KV**      | Serverless SQLite at the edge.     |
| **ORM**            | **Drizzle ORM**           | Lightweight, type-safe SQL ORM.    |
| **UI**             | **Tailwind V4 + Shadcn**  | Modern, accessible styling.        |
| **Infrastructure** | **Alchemy.run**           | TypeScript-based IaC.              |
| **Linting**        | **Biome**                 | Fast linting and formatting.       |

---

## Project Structure

```text
starter/
├── apps/
│   ├── server/    # Hono Server Worker
│   └── web/       # TanStack Start Frontend Worker (port 3000)
└── packages/
    ├── api/       # Shared ORPC API definitions & Zod schemas
    ├── db/        # Drizzle Schema & Migrations
    ├── ui/        # Shared Shadcn UI components
    └── config/    # Shared TS configs
```

---

## ⚡️ Getting Started

> **New here? Follow the full tutorial** — [docs/quickstart.md](docs/quickstart.md)
> walks from "Use this template" through your first manual deploy to
> multi-environment CI auto-deploy, including the required auth env.

### Prerequisites

- Node.js (v23.6+ — the project runs `.ts` files directly via Node)
- pnpm (`npm i -g pnpm`)
- Cloudflare Account

### 1. Installation

Clone the repo and install dependencies.

```bash
git clone https://github.com/saasflare-dev/starter.git
cd starter
pnpm install
```

### 2. Development

Both apps launch with `--env-file .local.env` and **fail to start if that file is
missing**, so create both before the first run. Empty files are fine —
`alchemy dev --stage local` hardcodes `http://localhost:3000` / `:4000` for
CORS and the client bundle, and every other value has a working local default.

```bash
cp apps/server/.local.env.example apps/server/.local.env
cp apps/web/.local.env.example    apps/web/.local.env

pnpm dev
```

| App                | URL                    |
| :----------------- | :--------------------- |
| **Server**         | http://localhost:4000  |
| **TanStack Start** | http://localhost:3000  |

> `.local.env` is for local dev only. `.dev.env` / `.prod.env` are for stage deploys (CI-injected).

### 3. Authentication

Authenticate with Cloudflare to grant deployment permissions.

```bash
pnpm alchemy configure
pnpm alchemy login
```

### 4. Deployment

Deploy everything to Cloudflare's global network.

```bash
# Deploy to Dev
pnpm run deploy:dev

# Deploy to Prod
pnpm run deploy:prod
```

> **One-shot deploy.** URLs are resolved automatically inside `alchemy.run.ts`
> (via `computeWorkerDevDomain`), so `NEXT_PUBLIC_SERVER_URL` and `CORS_ORIGIN`
> never need to be filled in by hand — `deploy:dev` / `deploy:prod` work first
> time. Control-plane credentials live in `.alchemy.env` at the repo root;
> per-app deploy config (optional `WEB_DOMAIN` / `SERVER_DOMAIN`, auth, R2 keys)
> lives in `apps/{server,web}/.{stage}.env`. See
> [docs/deploy.md](docs/deploy.md) for the full runbook.

#### Automated CI/CD Deployment

This project ships two GitHub Actions workflows:

- **`deploy.yml`** — push to `dev` → deploys to the **Development** environment (`starter-web-dev.<account>.workers.dev`); push to `main` → deploys to **Production** (`starter-web-prod.<account>.workers.dev`).
- **`preview.yml`** — every PR opened against `dev` or `main` gets its own isolated stage (`pr-<N>`) with its own Worker, KV, D1, R2. A bot comment on the PR posts the preview URLs. Closing the PR auto-destroys the stage.

##### Required Secrets

The workflows read exactly five **Repository Secrets** (*Settings -> Secrets and variables -> Actions -> New repository secret*). Each is the full content of a local env file, which CI writes back to its original path before deploying:

| Secret | Local file | Contents |
| :--- | :--- | :--- |
| **`ENV_ALCHEMY`** | `.alchemy.env` | Control-plane credentials (`CLOUDFLARE_API_TOKEN`, `ALCHEMY_STATE_TOKEN`). Required — Actions cannot run the interactive `alchemy login`. |
| **`ENV_SERVER_DEV`** / **`ENV_SERVER_PROD`** | `apps/server/.dev.env` / `.prod.env` | Server Worker config |
| **`ENV_WEB_DEV`** / **`ENV_WEB_PROD`** | `apps/web/.dev.env` / `.prod.env` | Web deploy config |

There is no standalone `CLOUDFLARE_API_TOKEN` or `ALCHEMY_STATE_TOKEN` repository secret — those travel inside `ENV_ALCHEMY`. See [`.alchemy.env.example`](.alchemy.env.example) for how to generate them.

##### Upload env files to GitHub Secrets

Or use the helper script (skips missing files with a warning):

```bash
pnpm sync:secrets
```

Manual equivalent:

```bash
gh secret set ENV_ALCHEMY < .alchemy.env
gh secret set ENV_SERVER_DEV < apps/server/.dev.env
gh secret set ENV_SERVER_PROD < apps/server/.prod.env
gh secret set ENV_WEB_DEV < apps/web/.dev.env
gh secret set ENV_WEB_PROD < apps/web/.prod.env
```

---

## 📄 License

MIT © Saasflare

---

# Saasflare Starter 中文

Saasflare Starter 是一套**有主见（Opinionated）的全栈 Starter Kit**，专为 **Cloudflare 边缘网络**打造。它将 **TanStack Start**（前端）和 **Hono**（后端）作为独立的 Worker 运行，并通过**端到端（End-to-End）类型安全**进行连接。告别繁琐配置，**一条命令全球部署。运行成本 $0/月。**

---

## 🚀 核心特性

- **零成本**: 100% 运行在 Cloudflare (Workers + D1) 上。绝大多数个人项目/初创应用 $0/月。
- **端到端类型安全**: 共享 Zod Schema + ORPC。前端调用后端就像调用本地函数一样。
- **基础设施即代码**: 由 **Alchemy.run** 驱动。告别 `wrangler.toml`。只写 TypeScript。
- **AI 优先工作流**: 为 LLM 优化。内置 [GEMINI.md](./GEMINI.md) 上下文文件，AI 助手开箱即用。
  - Prompt 示例: "阅读 GEMINI.md，然后在创建 todos 表并暴露一个 getTodos API。"

---

## 🛠️ 技术栈

| 类别               | 技术                      | 描述                         |
| :----------------- | :------------------------ | :--------------------------- |
| **Frontend**       | **TanStack Start**        | 针对边缘优化的 React 框架。  |
| **Backend**        | **Hono**                  | 超快的 Web 标准框架。        |
| **Communication**  | **ORPC + TanStack Query** | 端到端类型安全 RPC           |
| **Database**       | **Cloudflare D1/KV**      | 边缘 Serverless SQLite。     |
| **ORM**            | **Drizzle ORM**           | 轻量级、类型安全的 SQL ORM。 |
| **UI**             | **Tailwind V4 + Shadcn**  | 现代化的原子类与组件库。     |
| **Infrastructure** | **Alchemy**               | 基于 TS 的基础设施即代码。   |
| **Linting**        | **Biome**                 | 极速 Lint 和格式化。         |

---

## 项目结构

```text
starter/
├── apps/
│   ├── server/    # Hono 后端 Worker
│   └── web/       # TanStack Start 前端 Worker（端口 3000）
└── packages/
    ├── api/       # 共享 ORPC API 定义 & Zod Schemas
    ├── db/        # Drizzle Schema & Migrations
    ├── ui/        # 共享 Shadcn UI 组件
    └── config/    # 共享 TS 配置
```

---

## ⚡️ 快速开始

> **新用户请看完整教程** —— [docs/quickstart.md](docs/quickstart.md)：
> 从 GitHub「Use this template」到手动部署到自己的 Cloudflare 账号，
> 再到多环境自动部署（含必填的 auth 环境变量），一步步走完。

### 前置要求

- Node.js (v23.6+ — the project runs `.ts` files directly via Node)
- pnpm (`npm i -g pnpm`)
- Cloudflare 账号

### 1. 安装

克隆仓库并安装依赖。

```bash
git clone https://github.com/saasflare-dev/starter.git
cd starter
pnpm install
```

### 2. 开发

两个 app 启动时都会传 `--env-file .local.env`，**文件不存在会直接启动失败**，所以首次运行前两个都要建。内容可以完全为空 —— `alchemy dev --stage local` 把 CORS 和客户端 bundle 都写死成 `http://localhost:3000` / `:4000`，其余每一项本地都有可用的默认值。

```bash
cp apps/server/.local.env.example apps/server/.local.env
cp apps/web/.local.env.example    apps/web/.local.env

pnpm dev
```

| 应用               | URL                    |
| :----------------- | :--------------------- |
| **Server**         | http://localhost:4000  |
| **TanStack Start** | http://localhost:3000  |

> `.local.env` 仅用于本地开发；`.dev.env` / `.prod.env` 用于 stage 部署（CI 注入）。

### 3. 认证

登录 Cloudflare 授权部署权限。

```bash
pnpm alchemy configure
pnpm alchemy login
```

### 4. 部署

将所有应用部署到 Cloudflare 全球网络。

```bash
# 部署到开发环境
pnpm run deploy:dev

# 部署到生产环境
pnpm run deploy:prod
```

> **一次部署即可。** `alchemy.run.ts` 通过 `computeWorkerDevDomain` 自动解析 URL，`NEXT_PUBLIC_SERVER_URL` 和 `CORS_ORIGIN` 不需要手填，`deploy:dev` / `deploy:prod` 首次运行就能跑通。控制面凭证放在仓库根目录的 `.alchemy.env`；各 app 的部署配置（可选 `WEB_DOMAIN`/`SERVER_DOMAIN`、auth、R2 keys）放在 `apps/{server,web}/.{stage}.env`。完整流程见 [docs/deploy.md](docs/deploy.md)。

#### 自动化 CI/CD 部署

本项目提供两个 GitHub Actions 工作流：

- **`deploy.yml`** — push 到 `dev` → 部署到 **开发环境** (`starter-web-dev.<account>.workers.dev`)；push 到 `main` → 部署到 **生产环境** (`starter-web-prod.<account>.workers.dev`)。
- **`preview.yml`** — 每个针对 `dev` / `main` 的 PR 自动创建独立 stage (`pr-<N>`)，独占 Worker / KV / D1 / R2。bot 会在 PR 评论里贴预览 URL；PR 关闭时自动销毁该 stage。

##### 所需 Secrets

工作流实际只读取五个 **Repository Secrets** (*Settings -> Secrets and variables -> Actions -> New repository secret*)。每个 secret 都是某个本地 env 文件的完整内容，CI 会在部署前把它写回原路径：

| Secret | 本地文件 | 内容 |
| :--- | :--- | :--- |
| **`ENV_ALCHEMY`** | `.alchemy.env` | 控制面凭证（`CLOUDFLARE_API_TOKEN`、`ALCHEMY_STATE_TOKEN`）。必需 —— Actions 跑不了交互式的 `alchemy login`。 |
| **`ENV_SERVER_DEV`** / **`ENV_SERVER_PROD`** | `apps/server/.dev.env` / `.prod.env` | server Worker 配置 |
| **`ENV_WEB_DEV`** / **`ENV_WEB_PROD`** | `apps/web/.dev.env` / `.prod.env` | web 部署配置 |

没有独立的 `CLOUDFLARE_API_TOKEN` / `ALCHEMY_STATE_TOKEN` repository secret —— 它们随 `ENV_ALCHEMY` 一起传入。生成方式见 [`.alchemy.env.example`](.alchemy.env.example)。

##### 上传 env 文件到 GitHub Secrets

或使用辅助脚本（缺失的文件会跳过并给出提示）：

```bash
pnpm sync:secrets
```

手动等价：

```bash
gh secret set ENV_ALCHEMY < .alchemy.env
gh secret set ENV_SERVER_DEV < apps/server/.dev.env
gh secret set ENV_SERVER_PROD < apps/server/.prod.env
gh secret set ENV_WEB_DEV < apps/web/.dev.env
gh secret set ENV_WEB_PROD < apps/web/.prod.env
```

---

## 📄 License

MIT © Saasflare
