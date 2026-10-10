# Production candidate 上線準備

本文件僅為上線計畫，不會執行 migration、部署、DNS、webhook 或 push。正式執行須由使用者另外確認。

## Candidate 範圍

包含已完成驗收的管理介面、username/password/TOTP、外收財務與回帳比例、批量建檔、Telegram `/id`、姓名回報、原圖 caption/album、實際收款、後結、回報逾時、session idle 與案件分頁。Migration 0023～0041 及對應 snapshot/journal 一併提交。

測試中的假帳號、fake Telegram client 與付款 fixture 只供自動測試；正式環境不得執行 demo seed、bootstrap 測試帳號或 staging rehearsal。正式收款依有效實收 ledger；不以原始案件金額限制實收。最新簡化外收結算不新增舊制傭金計算；保留歷史紀錄。

## 正式資源與部署入口

2026-10-10 唯讀盤點：目前可存取的 Cloudflare 帳號只有 staging D1 和 staging API/Web，沒有 production D1/Worker。`kpirich.bid` zone 為 active，Worker custom domains 與 zone routes 為空。DNS records 讀取回覆 403，仍需具 DNS Read 權限的人確認 `admin`、`api` 的既有記錄。

建議獨立資源名稱（尚未建立）：

- API：`collection-admin-production-api`
- Web：`collection-admin-production-web`
- D1：`collection-admin-production-db`，binding `DB`
- Private R2：`collection-admin-production-private-media`，binding `CASE_BUCKET`，停用 public domain/r2.dev
- KV：獨立正式 namespace，binding `KV`

現有 Alchemy 入口仍使用 root `projectName=starter`，並建立 starter public R2；尚未完整宣告正式 `CASE_BUCKET`、Telegram bindings 和 cron。**不得直接執行預設 deploy:prod。** 後續須先核對獨立正式部署設定與實際 resource IDs，避免誤綁 staging 或建立錯誤資源。本輪只以本機、placeholder IDs 的正式 URL 設定通過 Worker dry-run，沒有驗證正式 bindings 可連線。

## Secrets / bindings checklist

- `AUTH_MODE=open` 或明確核准的 managed 模式；`ACCOUNT_AUTH_MODE=managed`，不得用 legacy-test。
- Worker Secret：`BETTER_AUTH_SECRET`、`ACCOUNT_TOTP_ENCRYPTION_KEY`（64 hex）、`TELEGRAM_TOKEN_ENCRYPTION_KEY`（32-byte Base64 AES-GCM）。保留密鑰版本及離線備份；有加密資料後不得任意換 key。
- 如使用 key rotation，配置 `ACCOUNT_TOTP_KEY_VERSION` 與 secret `ACCOUNT_TOTP_ENCRYPTION_KEYS`。
- `SERVER_URL=https://api.kpirich.bid`、`CORS_ORIGIN=https://admin.kpirich.bid`；前端 build 的 `NEXT_PUBLIC_SERVER_URL=https://api.kpirich.bid`。
- `CASE_STORAGE_MODE=r2`；`DB`、`CASE_BUCKET`、`KV` 必須是獨立正式資源。任何案件圖片仍透過登入及案件權限 API 回傳 bytes。
- `TELEGRAM_MODE=live`；使用正式用途專屬 Bot、webhook secret、active route/collector/chat/topic；不得沿用測試 Bot/群組。確認每隻 Bot 的 webhook 設定及現有程式支援的 secret/token 接口。
- 如使用環境 fallback Bot，配置 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` 為 Worker Secrets；後台 Bot token 只保存密文。
- `BUSINESS_TIMEZONE=Asia/Taipei`；`triggers.crons=["* * * * *"]`。目前背景工作由 D1 jobs 與 scheduled handler 執行，不要求不存在的 Queue binding。
- 圖片辨識如需啟用，另行核准並設定 `IMAGE_EXTRACTION_MODE`、`OPENAI_API_KEY`、`OPENAI_IMAGE_MODEL` 與 timeout/retry。Telegram report 圖片不進 R2/AI。
- 目前正式登入為密碼/TOTP，Resend/Email OTP 不作為主要登入必要條件。
- 正式 admin 初始化需獨立核准的安全離線程序；現有 `bootstrap-managed-admin.ts` 僅支援 local/staging，不可當作 production 初始化工具。

## Migration / deploy 順序

1. 核准正式資源、secrets、管理員初始化方式、部署設定及 DNS 權限。
2. 建立獨立 D1/private R2/KV，記錄實際 IDs；如果已有資料，先完整備份與還原演練，保留財務 ledger fingerprint、R2 reference inventory。
3. 空白 D1 依 journal 套用 `0000` → `0041`，共 42 個 migrations；已有資料庫僅套用實際未套用項，不能跳號。0041 是 `managed_sessions.last_activity_at` nullable 欄位。套用後驗證 journal、schema、FK=0、quick_check=ok，再次 apply 應無待套用。
4. 不匯入 staging 客戶、帳號、session、Bot token、route、media 或測試付款。完成核准的正式 admin 初始化。
5. 部署正式 API，先驗證 health、未登入拒絕、CORS、private media 與安全設定；保留 cron/webhook 啟用時點的操作紀錄。
6. 以正式 API URL build/deploy Web，再驗證登入及 desktop/mobile。
7. 綁定 `api.kpirich.bid` 至 API Worker、`admin.kpirich.bid` 至 Web Worker，驗證 TLS/CORS/cookie；不修改 apex 或 wildcard routes。
8. 使用者完成正式 collector、回帳比例、Bot、route 設定後，再核准啟用 webhook/背景派送及正式 smoke test。

## DNS checklist

建議採 Worker Custom Domains，由 Cloudflare 管理對應 DNS/TLS。需先確認沒有同 hostname 的既有衝突記錄。不可直接把此方案混用為手動 CNAME 至 workers.dev。

如選 Route 模式，需另外核對 proxied DNS 與精確的 `api.kpirich.bid/*`、`admin.kpirich.bid/*` route；不得設定 `*.kpirich.bid/*` 搶走其他站台。執行前需取得 DNS Read/Edit 與必要 Workers 權限。

參考：[Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## Rollback / recovery

- 首次正式部署目前沒有可回滾的舊 production Worker。應保存 candidate artifacts、部署設定、secrets 的安全備份，以及每次部署後的版本 ID。
- 發生問題先停止新增業務寫入與 webhook/cron 派送，保存事故時 D1 備份、待送 jobs/checkpoints 與有效交易，不盲目重送 `DELIVERY_UNKNOWN`。
- 有已驗證且 schema 相容的舊正式版本時才回滾 Worker；不能假設 66fb4c6 與全部財務 migrations 相容。
- 不用 DROP COLUMN/table 作為 migration rollback。0041 可保留欄位；財務 backfill 復原必須使用備份與交易對帳，不逆改歷史快照。
- 若需還原 D1，先評估恢復點後的新交易並停寫；協調 R2 reference、加密 key、Bot jobs/checkpoints，避免遺失付款或重複發送。
- DNS 初次上線失敗應只解除本次新增的綁定，不改動其他網域。任何正式 rollback 寫入仍需另外授權。

## 本輪檢查

TypeScript、唯讀 lint/Biome、正式 API URL 前端 build、staging 設定及正式 placeholder 設定的 Worker dry-run 已通過。Secret scan 同時核對候選與 staged 內容、provider token patterns、已知本機 secret 值及不應提交的檔案。正式 DNS records 因權限不足尚未確認；正式資源/secrets 初始化與連線驗證仍是上線前置條件。
