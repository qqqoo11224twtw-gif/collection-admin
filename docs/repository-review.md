# Repository 檢查與本機啟動

本次範圍：安裝、啟動、架構檢查與 starter 驗證；沒有實作委外業務功能、部署雲端資源、加入真實 API Key、設定 Telegram webhook 或匯入客戶資料。

## 驗證結果

| 項目 | 結果 |
| --- | --- |
| Node / 套件管理器 | Node 24.19.0；依 repository 指定使用 pnpm 10.24.0 |
| 安裝 | `install --frozen-lockfile` 成功，lockfile 未修改，Alchemy patch 保留 |
| 本機啟動 | `dev:local` 成功；web :3000、server :4000 |
| HTTP | 首頁 200，starter title 正確；`GET /health` 回傳 `{"status":"ok"}` |
| D1 migration | 3 份 migration 在獨立本機 SQLite 成功套用 |
| 前端 build | `build:local` 的 client 與 SSR Worker build 成功 |
| 後端 build | Wrangler `deploy --dry-run` 成功，只編譯、未部署 |
| TypeScript | 全部 workspace typecheck 通過 |
| 後端整合測試 | 6 個檔案、45 個測試通過（Miniflare D1/KV/R2） |
| 瀏覽器 E2E | 安裝 Chromium 後，9 個測試全部通過 |
| Lint / 格式 | lint 與 Biome CI 通過；修正 Windows CRLF 與 LF 規則衝突 |

整合與 E2E 使用 starter 的合成測試帳號與測試資料。測試產生的使用者、todos、撤銷的 key 紀錄只存在本機；沒有正式 API 憑證。雲端部署、真實郵件寄送、遠端 R2 上傳尚未驗證。

## 重現方式

建議安裝 repository 指定的 pnpm 10.24.0，使用 Node 24 以上：

```powershell
pnpm install --frozen-lockfile
pnpm dev:local
```

開啟 http://localhost:3000 ，API 在 http://localhost:4000 。請以 `localhost` 瀏覽前端，與現有 CORS 設定一致。另一個終端可執行：

```powershell
pnpm build:local
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
pnpm exec biome ci .
```

執行 E2E 前保留 `dev:local` 運行，因現有 Playwright 設定找不到 web 時會啟動原始 `pnpm dev`。首次 E2E 需 `pnpm --filter @saasflare-dev/web exec playwright install chromium`。

本次環境預裝 pnpm 11，因此安裝與驗證命令透過 `pnpm dlx pnpm@10.24.0 <command>` 執行，以避免 pnpm 11 忽略 root package.json 的 dependency patch / build 設定。

後端只編譯的命令（在 `apps/server` 執行）：

```powershell
pnpm exec wrangler deploy --dry-run --config wrangler.local.jsonc --outdir .wrangler/dry-run
```

`wrangler.local.jsonc` 僅供本機驗證，不能當正式部署設定使用。`dev:local` 使用獨立的本機 D1/KV/R2，略過 Alchemy 與 stage env 檔，並清除子程序繼承的 Cloudflare、Alchemy、R2、Resend 環境變數。它沒有真實 R2 S3 金鑰，因此預簽上傳仍會回報未配置；本機 bucket binding 不代表遠端上傳可用。

原始 `pnpm dev`、deploy scripts 與 Alchemy 設定保留不變。原始 dev 會先查詢 Cloudflare 帳號，而且 R2 指定 `dev.remote: true`，不能視為零帳號的離線啟動；此次成功驗證的是新增的純本機流程。

## 目錄與模組

| 目錄 / 檔案 | 目前用途 | 委外後台的延伸位置 |
| --- | --- | --- |
| `apps/server/src/index.ts` | Hono 入口、CORS、auth、oRPC、managed key API、health | 保留入口；新增必要的整合端點時明確選擇認證方式 |
| `apps/server/alchemy.run.ts` | Server Worker、D1 migrations、KV、R2 與 auth env 驗證 | 後續環境隔離與部署 |
| `apps/server/tests` | Auth 模式、API key、資料 ownership、storage 整合測試 | 案件授權、狀態轉換與附件權限測試 |
| `apps/web/src/routes` | 首頁、登入、todos／R2／API key／SSR 範例、design showcase | 新增案件列表、明細、編輯頁；先保留範例 |
| `apps/web/src/components` | AuthGate、UserMenu、表單與 starter 範例元件 | 案件表格、狀態標籤、表單與指派元件 |
| `apps/web/src/lib` | auth client、oRPC Query 整合、brand、上傳 helper | 沿用型別安全查詢與登入 client |
| `apps/web/src/styles` | Tailwind v4 與全域樣式 | 沿用既有 design system |
| `apps/web/alchemy.run.ts` / `vite.config.ts` | Web Worker 部署、SSR/client build、API URL 注入 | 保留跨 app URL 與部署流程 |
| `apps/web/e2e` | Playwright 登入、隔離、API key、首頁測試 | 案件新增與處理流程測試 |
| `packages/api/src/index.ts` | oRPC router：healthCheck、config、todos、storage、planet、apiKeys | 掛上新的 `jobs` 等業務 router |
| `packages/api/src/auth.ts` / `middleware.ts` / `context.ts` | better-auth、session、admin、public/protected/admin procedure | 沿用 auth；另定義管理者與承包商授權 |
| `packages/api/src/todos.ts` | 依 session user 隔離的 CRUD | 作為案件 CRUD 的參考，不直接覆蓋 demo |
| `packages/api/src/storage.ts` / `lib/s3.ts` | R2 預簽上傳、共用 bucket 列表與刪除 | 附件 metadata、案件 ownership、私有下載與授權 |
| `packages/api/src/config.ts` / `health-check.ts` | 公開配置與 binding 狀態探測 | 維運狀態頁 |
| `packages/api/src/email.ts` | Resend REST 寄信或本機 console fallback | 後續測試通知；不先接正式服務 |
| `packages/db/src/schema.ts` / `migrations` | Drizzle SQLite schema 與 3 份 migrations | 新增案件、委外廠商、指派、附件、歷程表 |
| `packages/ui` | 共用 Shadcn/ui 元件 | 直接使用；本次未修改 |
| `packages/config` | 共用 TypeScript 設定 | 保留 |
| `scripts` | 部署、同步 secrets、D1 query、URL 計算；新增 local launcher | 本機工具與後續部署維運 |
| `.github/workflows` | CI、dev/prod 部署、PR preview 與回收 | 後續配置自己的非正式環境 |
| `patches/alchemy.patch` | 修正開發 proxy 的 client abort crash | 保留 |
| `docs` | Auth、API、D1、UI、部署與測試文件 | 本報告與後續业务規格 |
| `.claude/agents` / `.mcp.json` | starter 的瀏覽器測試輔助設定 | 本次未啟用 agent 或外部 MCP |
| root `package.json` | workspace scripts 與 saasflare 產品識別 | 確定品牌與部署命名後再改 |

## 現有技術與 binding

前端：React 19、TanStack Start / Router / Query、Vite 8、Tailwind v4、Shadcn/ui、TypeScript。後端：Hono、oRPC、Zod v4、better-auth 1.6、Drizzle、Cloudflare Workers。工具：pnpm workspaces、Alchemy IaC、Wrangler、Biome、Vitest workers pool、Playwright。

瀏覽器 → oRPC client + TanStack Query → Hono `/rpc/*` → middleware/context → Drizzle D1 或 KV/R2。Auth 使用 `/api/auth/*`；外部 managed key API 範例為 `/api/v1/whoami`。

| 資源 | 原始 Alchemy 架構 | 新增本機設定 | 實際雲端狀態 |
| --- | --- | --- | --- |
| Workers | web 與 server 兩個 Worker | 兩個本機 Worker runtime | 未登入／未查詢／未部署 |
| D1 `DB` | 已宣告，掛載 server，套用 migrations | 已掛載且完成 migrations | 無法由 repo 宣告證明雲端已建立 |
| KV `KV` | 已宣告，掛載 server | 已掛載本機 namespace | 未驗證 |
| R2 `BUCKET` | bucket 無條件宣告且本機原始流程使用遠端；Worker binding 僅在兩個 R2 金鑰都有值時掛載 | 已掛載本機 bucket，沒有 S3 金鑰 | 未驗證 |

現有 D1 業務表只有 `todos`；另外是 `user`、`session`、`account`、`verification`、`apikey`、`rate_limit` 六張 auth 相關表，還沒有委外、客戶、廠商或案件 schema。

## 登入方式

1. 輸入 Email，請求六位 OTP，驗證後取得 httpOnly session cookie；新 Email 首次驗證會自動註冊。
2. Auth/session 由 better-auth 管理並存於 D1；session cookie cache 為 300 秒。
3. `AUTH_MODE=open` 可註冊登入；`admin-only` 僅 `ADMIN_EMAILS` 白名單可取得登入碼；`disabled` 關閉 auth 路由及受保護 API。
4. 原始本機預設 `open`，部署預設 `disabled`；真正啟用部署登入需明確配置 secret、Resend、sender 與管理員白名單。
5. 本機不寄信，OTP 印在 server terminal，也可由 `/api/dev/otp?email=...` 讀回。新增本機範例白名單為 `admin@example.test`，只供合成資料測試。
6. `ADMIN_EMAILS` 使用者可取得 admin role；加入白名單會提升既有帳號，移除白名單不自動降權。
7. API Key 功能屬於使用者管理的 key；資料庫存 hash，明文只於建立時回傳一次。此次 E2E 在本機建立測試 key 並撤銷。

## 改為委外後台的第一步

第一個新增模組建議為「委外案件／工作單」，先做合成資料的案件列表、建立、明細、狀態與指派：案件編號、標題、承包商、負責人、期限、狀態。沿用 todos 的 CRUD 與 ownership pattern，另建 D1 schema、`packages/api/src/jobs.ts` 與 `apps/web/src/routes/jobs/`；starter todos、storage、SSR 範例繼續保留。

先定義管理員可見全部案件、承包商僅見指派案件等權限；不能直接把 todos 的「個人私有」規則當作團隊合作模型。接著才新增廠商／聯絡人、附件與操作歷程。後台正式環境可考慮沿用 `admin-only`，仍需依實際角色設計決定。

上線前值得修正的現有細節：

- `health-check.ts` 的 connection probe 會 log 整份 env，將來加真實 secret 前應移除或遮罩。
- `/api/dev/otp` 目前依「無 Resend key、auth 未 disabled」判斷，沒有獨立 stage gate；PR preview 又跳過完整 auth env 驗證，因此不能把本機 OTP 設定直接套到公開 preview。
- storage 是登入者共用 bucket 的 demo，任何已登入者可列出／刪除 key，尚無案件附件 ownership；委外文件應先補授權與私有下載。
- health probes 主要檢查 binding 是否存在，不能視為完整的雲端讀寫可用性證明。
- 沒有發現現有 Telegram bot/webhook 模組。本次不新增；未來先以本機模擬通知介面開發。

## 本次變更

新增 `.gitattributes` 固定 LF，兩個 `wrangler.local.jsonc` 本機範例、`scripts/local.ts` 與本報告；root scripts 增加 `dev:local` / `build:local`；Vite 僅在 `LOCAL_ONLY=1` 時選擇本機配置。更新兩個既有 `.local.env.example` 的本機說明，並複製為 gitignored `.local.env`（沒有填入任何金鑰）。

格式化只修正 checkout 換行；Git diff 沒有 starter 功能變動。沒有改 schema、migration、Auth/API 功能或 `packages/ui`，沒有修改 lockfile，也沒有 commit 或 push。
