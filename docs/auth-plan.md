# Saasflare 统一鉴权开发与迁移计划

> 本文是跨仓库的架构决策与迁移路线。先在 `tasks` 完成真实试点，验证后再把稳定的共性能力抽回 `starter`。具体试点实施清单位于同级独立仓库的 `tasks/docs/auth-plan.md`。

最后更新：2026-07-15 · 当前阶段：**Phase 2（抽取到 Starter）完成 ✅（见 §9）；待启动 Phase 3 产品迁移**

## 1. 目标与边界

Saasflare 各产品统一以下底层能力和安全约定：

- Better Auth 身份表、Session 和请求上下文。
- `publicProcedure`、`protectedProcedure`、`adminProcedure` 服务端权限边界。
- 管理员引导、识别和管理规则。
- API Key 的创建、一次性展示、验证、到期和撤销。
- 登录、受保护路由、环境变量、迁移和测试规范。

统一不代表：

- 不做跨产品单点登录。各产品继续拥有独立 D1、用户和 Session。
- 不强制所有产品使用同一登录页面或开放注册策略。
- 不用用户 Session 代替 webhook 签名、支付协议、Service Binding 或机器凭证。
- 不强制公开站点接入鉴权。

## 2. 已定方案

### 2.1 Core Auth

- 使用 Better Auth + D1/Drizzle。
- 默认登录方式为邮箱 OTP，不实现密码注册、忘记密码和密码重置。
- 浏览器使用安全 Cookie Session；桌面端 Bearer 等能力作为产品扩展。
- Core 只包含用户身份，不在第一版引入 Organization、邀请或复杂 RBAC。
- `starter` 内置鉴权实现但允许关闭，支持三种模式：
  - `disabled`：纯公开产品，不挂载登录和 API Key 管理。
  - `open`：**面向客户的注册登录故事**——任意邮箱可通过 OTP 注册/登录（默认无密码；社交登录等作为产品扩展）。
  - `admin-only`：仅 `ADMIN_EMAILS` 白名单可登录，适合内部控制台。
- 三种模式是**同一 auth 实例的不同配置**，不是并行系统：`admin-only` = `open` 关闭开放注册 + OTP 发送前白名单 gate（Tasks 试点已验证此收紧路径）。非白名单邮箱返回显式 403 `EMAIL_NOT_ADMIN`（产品取舍：私有后台里明确报错优于防枚举；`open` 模式产品可自行权衡）。
- starter 本体默认 `open`，disabled 模式下受保护 procedure 一律 401 fail closed；模式开关、env 校验矩阵与 demo 改造等 Phase 2 模板决策见 §8。

### 2.2 管理员能力

- 使用 `ADMIN_EMAILS` 环境白名单引导管理员，禁止“首个注册用户自动成为管理员”。
- 白名单邮箱首次登录时自动获得管理员角色；后续加入白名单的已有用户可自动提升。
- 从环境白名单移除邮箱不自动降权，避免配置事故导致无人可管理；降权必须通过管理员操作完成。
- Admin API 提供用户列表、角色查看、提升和降权，并禁止降权或删除最后一个管理员。

### 2.3 API Key

- 使用 Better Auth 官方 API Key 插件，不复制 `notify` 当前的自建 Token 逻辑。
- 用户登录后台后创建多个具名 Key；明文只展示一次，列表和数据库不泄漏秘密。
- Key 支持独立撤销和产品预设权限；**有效期在创建时选择**（试点定型：默认永不过期 + 7d/30d/90d/1y 预设，上限 365 天）。
- 注意插件行为：**过期 Key 会在任意 api-key 端点被调用时被自动删除**（10s 冷却）——列表中不会长期显示「已过期」，产品文档需向用户说明；调用方拿到的是与其他无效 Key 相同的通用 401。
- 第一版不向用户暴露权限编辑 UI。产品服务端决定 Key 的固定用途，例如 `tasks:trigger` 或 `notifications:send`。
- ~~环境变量中的共享 Key 仍可用于单一可信内部调用方~~ 试点结论：共享环境 Key 应彻底避免——Tasks 的 `TASKS_API_KEY` 已于 2026-07-15 删除，新产品不应再引入；单一内部调用方优先用 Service Binding（平台鉴权、零 Key）。

### 2.4 Cloudflare Access

- Cloudflare Access 是可选部署边界，用于保护 dev、preview、内部控制台或 `/admin`。
- Access 不替代产品用户、数据归属、管理员角色或 API Key。
- Tracker、支付页、webhook、订阅入口等公开或协议鉴权路由不得被统一登录误拦截。

## 3. 实施顺序

### Phase 1：Tasks 垂直试点 ✅（2026-07-15 完成）

在 `tasks` 验证了完整链路：

1. ✅ 管理员通过邮箱 OTP 登录（两步 UI + AuthGate + dev-only OTP 读回支撑 E2E）。
2. ✅ 管理员创建具名 Trigger API Key（含创建时选有效期）。
3. ✅ 外部程序使用 Key 调用 `POST /api/v1/tasks/trigger`（含 idempotencyKey 去重）。
4. ✅ Key 到期或撤销后立即失效（撤销即刻 401；过期行为见 §2.3 注意事项）。
5. ✅ 原 `TASKS_API_KEY`：确认无实际调用方后跳过迁移窗口，2026-07-15 直接删除（代码/绑定/env/文档/测试全清）。

试点全过程与评估记录在 `tasks/docs/auth-plan.md`（A0–A7）。`notify` Token 未动，Organization 未提前抽象。

### Phase 2：抽取到 Starter

把 Tasks 中经过真实使用验证的共性整理到 `starter`：

- Better Auth 工厂、Drizzle schema、Hono Handler 和类型化 Session。
- 统一 oRPC 中间件和 Context。
- 登录、退出、Auth Gate、管理员入口和 API Key 管理示例。
- `disabled`、`open`、`admin-only` 配置模式。
- 产品权限声明与 API Key 验证辅助函数。
- 环境变量、D1 迁移、部署和安全路由清单。
- Miniflare 集成测试与 Playwright 登录测试范式。

冻结这些公共接口前，必须先吸收 Tasks 试点中发现的问题。

### Phase 3：现有产品迁移

1. **`analytics`、`subscribe`**
   - 从自建单密码 Session 迁移到 `admin-only` Core Auth。
   - 删除 `DASHBOARD_PASSWORD` 和自建 Session 代码。
   - 上线后旧 Session 失效，管理员通过 OTP 重新登录。

2. **`affiliate`**
   - 对齐 starter 的 Context、中间件、环境变量和管理员规则。
   - 保留 Affiliate 领域角色，不引入 Organization。
   - 尽量复用现有 Better Auth 表，避免无意义的数据迁移。

3. **`notify`**
   - 先对齐 Core Auth，保留 Bearer、社交登录、一次性桌面登录等产品扩展。
   - 暂时保留现有 `ntfy_` Token。
   - Tasks Key 稳定后再设计双验证窗口，逐个轮换旧 Token。

4. **`onePay`**
   - 支付页、回调、webhook 和 x402 路由保持公开或协议鉴权。
   - 当前 Operator API Key 不强行迁移成用户 Key。
   - 出现商户控制台后接入 Core Auth；确认多人商户需求后才引入 Organization。

5. **`website`**
   - 保持 `disabled`。
   - 清理或保护遗留 starter 示例写接口；内部页面可使用 Cloudflare Access。

## 4. 公共接口目标

请求 Context 统一提供：

```ts
type AuthContext = {
  session: AuthSession | null;
  user: AuthUser | null;
  isAdmin: boolean;
};
```

oRPC 统一导出：

```ts
publicProcedure;
protectedProcedure;
adminProcedure;
```

API Key 验证结果统一包含：

```ts
type VerifiedApiKey = {
  keyId: string;
  userId: string;
  permissions: Record<string, string[]>;
  expiresAt: Date | null;
};
```

每条 HTTP/oRPC 路由必须明确选择一种保护方式：Public、User Session、Admin Session、Managed API Key、产品特定签名/Key 或 Cloudflare Service Binding。

## 5. 测试与验收标准

- Miniflare 集成测试覆盖三种 Auth 模式、Session、管理员规则和 API Key 生命周期。
- 服务端测试证明匿名请求无法进入管理接口，公开入口不被误拦截。
- Key 测试覆盖有效、伪造、过期、撤销和权限不匹配。
- Playwright 覆盖 OTP 登录、受保护路由、退出、Key 一次性展示和撤销。
- 每个迁移仓库必须通过 `pnpm test`、`pnpm typecheck`、`pnpm exec biome ci` 和关键登录 E2E。
- 涉及环境变量、数据库或系统结构时，同步更新对应仓库的环境、数据库和架构文档。

## 6. 长期维护

- `starter` 是鉴权规范源，不维护多个长期 auth Git 分支。
- 每个产品记录采用的 Auth 模式、公开路由和产品扩展。
- 通用安全修复先进入 `starter`，再通过定期同步 PR 下发到产品仓库。
- 产品允许定制，但偏离公共行为时必须在本仓库文档中记录原因和兼容策略。

## 7. Tasks 试点结论回填（2026-07-15）

完整评估见 `tasks/docs/auth-plan.md` 的「A7 试点评估记录」；对 starter 抽取有直接影响的结论：

### 7.1 better-auth 1.6.23 文档偏差（抽取时必须写进 starter 文档/代码注释）

| 项 | 文档说法 | 实际行为 |
|---|---|---|
| `createApiKey.expiresIn` | 秒 | 秒 ✓ |
| `keyExpiration.defaultExpiresIn` | 毫秒 | **秒**；`null` = 永不过期 |
| `keyExpiration.minExpiresIn/maxExpiresIn` | — | 单位是**天**（默认 1/365） |
| `listApiKeys` 返回 | — | `{ apiKeys }` 包裹对象 |
| Key 属主字段 | — | `referenceId` |
| 每 Key rate limit | — | **默认 10 次/天**，API 场景必须显式 `rateLimit: { enabled: false }` |

另：过期 Key 在任意 api-key 端点被调用时自动批删（10s 冷却）。

### 7.2 工程模式（已验证，直接照搬）

- 白名单 gate 放在 Hono 层、better-auth **之前**（否则 verification 行先落库）；插件 APIError 在 vitest workers pool 需 `onUnhandledError` 精准放行。
- Hono 中间件读 `cloudflare:workers` 全局 `env`，不要用 `c.env`（`app.fetch(req)` 测试不传 env）。
- 测试全走真实 Miniflare/D1 无 mock；HTTP Key 测试在 `beforeAll` 经 oRPC 创建 Key。
- `db:generate` 后自动 biome format migrations/，否则 meta JSON 挂 CI。
- 部署 fail-closed：dev/prod 缺 `BETTER_AUTH_SECRET`/`RESEND_API_KEY`/`EMAIL_FROM` 时 alchemy 直接抛错。

### 7.3 抽取清单（Phase 2 的具体范围，来自 Tasks 现有实现）

- `packages/api`：auth 实例工厂（emailOTP + admin + 白名单引导提升 + 可选 apiKey 模块）、`middleware.ts` 三档 procedure、`email.ts`、`api-keys.ts` oRPC 组。
- `packages/db`：`user/session/account/verification/apikey` schema 与迁移。
- `apps/server`：白名单 gate、dev-only OTP 读回端点、fail-closed 检查。
- `apps/web`：`AuthGate`、两步 OTP 登录页、`ApiKeysManager` 组件、账号菜单；e2e `auth-helpers.ts`。
- 试点实际的 Key 验证返回形状是 `{ valid, keyId?, userId? }`（§4 目标中的 `permissions/expiresAt` 产品尚未用到）——抽取时按 §4 目标补全即可，无阻碍。

### 7.4 与产品方向的对齐（2026-07-15 与用户确认）

- 各产品**独立用户池，不做跨产品 SSO**（维持 §1 边界；如未来要 SSO，是在上面加中心化认证层，不影响本抽象）。
- starter 的 `open` 模式定位为**客户注册登录**能力：默认无密码邮箱 OTP；社交登录、密码体系按产品需要作为扩展，不进 Core 第一版。
- 管理员模式是同一实例的收紧配置；每个产品无论何种模式都保留 `ADMIN_EMAILS` 管理员通道。

## 8. Phase 2 模板决策（2026-07-15，与用户确认）

### 8.1 定位与默认模式

starter 是**面向 to-C 产品**的模板，第一故事是客户注册登录，不是内部控制台。因此：

- **starter 本体默认 `AUTH_MODE=open`**，并以自身 demo 作为 `open` 模式的第一个验证者
  （Tasks 试点只验证了 `admin-only` 收紧路径，`open` 的开放注册链路由 starter 自测补上）。
- `disabled` 供纯公开站（如 `website`）显式选择；`admin-only` 供内部控制台（如 `analytics`）显式收紧。
- 无论何种模式（disabled 除外），`ADMIN_EMAILS` 管理员通道保留（§7.4）。

### 8.2 `disabled` 模式的 fail-closed 语义

- `protectedProcedure` / `adminProcedure` 中间件先读模式：`disabled` 时**运行时一律抛 401**，
  错误码 `AUTH_DISABLED`（与「未登录」的 401 可区分，便于排查）。不做启动期路由树检测——
  运行时兜底是无条件 fail closed，哪怕 clone 忘了删受保护路由，最坏也是调不通而非裸奔。
- 约定：disabled 产品应删除不用的受保护路由；401 兜底是保险丝，不是常态。

### 8.3 `AUTH_MODE` 与 env 校验矩阵

`AUTH_MODE` 是唯一的模式开关，只在服务端 env 存一份；取值三选一，拼错时 alchemy 部署直接失败。
前端不重复配置——经公开的 config 探针（Tasks `config.status` 模式）取回当前 mode 决定是否挂载登录 UI。

| 变量 | disabled | open | admin-only |
|---|---|---|---|
| `AUTH_MODE` | 必须合法 | 必须合法 | 必须合法（缺省默认 `open`） |
| `BETTER_AUTH_SECRET` | 不要求 | 部署环境必填 | 部署环境必填 |
| `RESEND_API_KEY` / `EMAIL_FROM` | 不要求 | 部署环境必填 | 部署环境必填 |
| `ADMIN_EMAILS` | 不要求 | 必填（管理员通道，§7.4） | 必填（否则无人可登录） |

alchemy 的 fail-closed 部署检查（§7.2）按此矩阵分档执行，不再无条件要求全部密钥。

### 8.4 `open` 模式加固

- **OTP 发信端点限流**：open 模式下发送 OTP 对任意邮箱开放，等于把 Resend 账号暴露为轰炸器；
  必须启用 better-auth 内置 rate limit（注意与 api-key 插件的每 Key 限流是两套东西，§7.1）。
- Miniflare + Playwright 覆盖 open 链路：任意邮箱注册 → 普通角色 → 进不了 admin 接口。

### 8.5 Demo 改造（充分展示注册登录故事）

- **删除遗留 demo：自建 `users` 表 + `usersApi` + playground users 页**——与 better-auth 的
  `user` 表命名冲突、且是无鉴权 CRUD；schema 里无人使用的 `posts` 表一并删除。
- `todos` demo 改造为**登录用户私有数据**：加 `userId` 归属列，API 切 `protectedProcedure`，
  只读写当前用户自己的数据——用它展示「注册 → 登录 → 个人数据 → API Key」的完整 to-C 故事。
- 公开面只保留 health check（及 config 探针）。

### 8.6 附带事项（已完成）

- 开工时核对 starter 锁定的 alchemy 版本是否已含 Tasks 试点发现的 dev 代理崩溃修复
  （`tasks/patches/alchemy.patch`）；未包含则一并携带。
- Phase 2 合入 `dev` 后，`feat/desktop-template` 按分支策略 rebase 一次；桌面端 Bearer
  作为「产品扩展」对新 auth 工厂适配。

## 9. Phase 2 完成记录（2026-07-15）

按 §7.3 清单 + §8 决策全部落地，三道闸（44 集成测试 / typecheck / biome ci）
+ 本地 e2e 8/8 全绿：

- `packages/db`：user/session/account/verification/apikey 五表 + `rate_limit`
  表（better-auth 内置限流的 D1 存储）；删除遗留 `users`/`posts` demo 表；
  `todos` 加 `userId` 归属列（迁移 `0002`）；`db:generate` 自动 biome format。
- `packages/api`：`auth.ts`（`authMode()` 三档 + 懒加载单例工厂 + Key 封装 +
  promotion-only 管理员同步）、`middleware.ts`（disabled → 401
  `AUTH_DISABLED` fail closed）、`email.ts`、`api-keys.ts`（protectedProcedure
  ——to-C：任意用户管理自己的 Key）、`config.ts`（探针含 authMode）；todos 全部
  按 session 用户过滤；storage 切 protected，planet/health 显式 public。
- `apps/server`：admin-only 白名单 gate（Hono 层、better-auth 之前）、
  `/api/auth/*` 挂载（disabled 404）、`/api/v1/whoami` Key demo、dev-only OTP
  读回；alchemy 按 §8.3 矩阵分档 fail-closed，`AUTH_MODE` 非法直接部署失败；
  携带 `patches/alchemy.patch`。
- `apps/web`：两步 OTP 登录页（按模式自适应文案/禁用页）、`AuthGate`、
  `UserMenu`、`ApiKeysManager`、`ConfigNotice`（探针驱动，前端不配模式）；
  playground 重构为「注册登录 → 私有 Todos → API Keys」的 to-C 故事；
  orpc client 走 `credentials: 'include'`。
- 测试：三模式矩阵（open 注册/admin-only 403+零残留/disabled 全 404+旧
  session 失效）、Key 全生命周期、todos 归属隔离、探针矩阵、dev OTP；e2e
  覆盖 UI 注册登录、redirect 回跳、跨账号隔离、Key 创建→调用→撤销→401。
  测试用 `testEnv` 动态切 `AUTH_MODE`（env 懒读使然）。
- 文档：新增 **`docs/auth.md`**（面向 clone 后 agent 的配置指南：三模式、env
  矩阵、插件偏差表、两套限流区别、"不要简化"清单、提交自查）；
  environment.md / AGENTS.md / .local.env.example 同步。
- 与 §4 公共接口目标的偏差：`VerifiedApiKey` 仍为试点形状
  `{ valid, keyId, userId }`（`permissions`/`expiresAt` 尚无消费方，产品需要
  时按 §4 补全）；Admin API 的用户列表/升降权管理面（§2.2 后半）未随模板
  实现——等首个需要它的产品出现再抽取。
- open 模式状态：已由 starter 自身 demo + 测试验证注册链路；仍待首个生产
  使用者（subscribe）验证真实邮件送达与转化，维持 §8.1 标注。
