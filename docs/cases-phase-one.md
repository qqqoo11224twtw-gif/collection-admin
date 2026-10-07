# 委外案件管理：第一階段

此階段提供案件閱讀與搜尋，以及受權限保護的圖片瀏覽。原 starter 範例與登入流程保留；沒有 Telegram、OpenAI、正式部署、財務統計、分期排程、製圖或 AI 辨識功能。

## 本機使用

```powershell
pnpm dev:local
```

使用 Node 24、repository 指定的 pnpm 10.24.0。啟動前檢查 :3000 / :4000，套用 D1 migrations，然後以 idempotent seed 寫入 18 筆完全虛構案件與 12 筆圖片 metadata。Seed 使用 `--local`，不放在 migrations，正式部署不會自動寫入示範資料。重跑保留既有資料，不覆蓋或清空 D1。

開啟 http://localhost:3000/cases 。使用現有 OTP 登入：

| 合成帳號 | 可見範圍 |
| --- | --- |
| `admin@example.test` | 所有 18 筆 demo 案件 |
| `agent@example.test` | 指派的 6 筆案件 |
| 其他測試 Email | 沒有指派時顯示 empty state |

不會寄送郵件。登入碼從 server console，或 `http://localhost:4000/api/dev/otp?email=admin%40example.test` 取得。

## 資料模型

`packages/db/src/schema.ts` 新增：

- `cases`：id、case_no、code、customer_name、address、amount_due、status、revisit_status、revisit_reason、source、assigned_agent_id、created_at、updated_at。
- `case_media`：id、case_id、storage_key、original_filename、media_type、sort_order、sha256、created_at。

案件編號使用 NOCASE unique index。姓名、代號、案件編號具有 NOCASE 搜尋索引；另外有更新時間及指派者／更新時間索引。圖片有案件／排序索引、唯一 storage key 與 SHA-256 索引。

`assigned_agent_id → user.id` 使用 `ON DELETE SET NULL`；`case_media.case_id → cases.id` 使用 `ON DELETE CASCADE`。刪除 metadata 的外鍵 cascade 不會自動刪除未來 R2 object，正式刪除流程需要另行處理 storage lifecycle。

Status：pending、assigned、follow_up、installment、settled、unresolved。Source：manual、poster_builder、telegram_ai、historical_import。Source 在此階段只是 demo metadata，不會啟動任何整合。

二訪狀態定義為 pending、recommended、not_required，搭配原因文字。金額在此階段以整數 TWD 元處理，Zod 拒絕負值、小數與超出範圍的數字；沒有金額統計或排程。資料庫另外限制非負值、enum、必要文字、時間順序、圖片格式與 hash。

Migration `0003_curly_bushwacker.sql` 由 Drizzle CLI 產生；journal / snapshot 同步生成，沒有手工建立 migration。

## API 與搜尋

`packages/api/src/cases.ts` 提供 `cases.list`、`cases.detail`、`cases.media` 三個受保護的 oRPC procedures。

List 的 page 從 1 開始，預設 10 筆、最多 50 筆；以 updated_at 降冪及 id 升冪穩定排序，count 與資料查詢在 D1 batch 中讀取。UI 提供上一頁／下一頁與 loading、empty、error、重試狀態。

全域搜尋在已登入的 app header，250ms debounce；案件列表另有 filter。姓名、代號、案件編號採「前綴」，地址採「包含」比對。大小寫不敏感範圍遵循 SQLite NOCASE（ASCII），中文字按原字比對。每個搜尋 branch 的 id 用 UNION 合併去重，再套用案件可見範圍，因此搜尋結果與總數都不會洩漏其他人的案件。

搜尋使用參數化 SQL 並 escape LIKE 的 `%`、`_`、`!`，不把輸入直接拼入 SQL。三個前綴 branch 使用索引，測試用 EXPLAIN QUERY PLAN 驗證；地址包含搜尋在第一階段仍是 D1 scan，尚未加入 FTS 或外部搜尋服務。

同名客戶保留不同 case id / case no.，搜尋結果可直接进入案件詳情；命中超過六筆可跳到完整搜尋列表。

## 圖片與權限

`case_media.case_id` 是一對多關係，metadata 依 sort_order / id 排序。每張 demo 圖片是可重現的 600×360 PNG 抽象文件版面，沒有真人、真實地址或客戶內容。

瀏覽器取得 metadata 時只收到 media id、檔名、類型、排序及時間，不收到 storage key、hash 或 public URL。圖片 API：

```text
GET /api/cases/:caseId/media/:mediaId/image
```

伺服器流程：Auth mode / session → case-level access → case id + media id 的聯合查詢 → private storage adapter → SHA-256 完整性驗證 → image response。

權限集中於 `packages/api/src/case-access.ts`：admin 可以查看全部案件；一般登入者只可查看 `assigned_agent_id = user.id` 的案件。列表、搜尋、詳情、media metadata 與 image bytes 都使用此規則。不存在與無權查看的案件／圖片均回 404；未登入為 401。前端 AuthGate 是 UX，不能取代 server 權限。

圖片回應加上 `Cache-Control: private, no-store` 與 `X-Content-Type-Options: nosniff`。瀏覽器使用帶 session credentials 的 fetch，再建立暫時 blob URL 作為 thumbnail；切換分頁／離開時 abort request 並 revoke blob URL。案件 Query cache 的 key 包含 user id，避免換帳號後顯示前一位使用者的 cached 資料。

## 未來 private R2 接點

`packages/api/src/case-storage.ts` 定義 `PrivateCaseStorage.read(key)`，已有兩個 implementation：

- `DemoCaseStorage`：本機 `CASE_STORAGE_MODE=demo`，只讀取已知的 fixture keys；限定真正的 `http://localhost` server URL。
- `R2CaseStorage`：使用私有 `CASE_BUCKET.get(key)`，不使用 public domain、S3 key 或 public presigned URL。Miniflare 測試已使用本機 R2 驗證 adapter。

正式接入時，在 `apps/server/alchemy.run.ts` 宣告獨立私有 R2 bucket 並掛載 `CASE_BUCKET`，設定 `CASE_STORAGE_MODE=r2`，把 object key 存進 case_media。不要復用 starter 的 public `BUCKET` / r2.dev upload demo。此階段只有 type / adapter 接點，尚未 provision CASE_BUCKET 或連接遠端 R2。

伺服器無法配置 adapter 或 hash 不符時回傳通用 503，不退回 public URL。取得 PNG/JPEG/WebP 原圖後由 UI 縮放作 thumbnail；未實作獨立 thumbnail 轉檔、上傳、刪除或重排操作。

## 畫面

案件列表欄位：客戶、代號、案件編號、status badge、應收款、更新時間。採現有 Shadcn Table、Input、Button、Badge、Skeleton 等元件，沒有修改 `packages/ui`。

詳情 tabs：Overview、Outsourcing images、Assignment history、Report history、Payment history、Activity log。後四者為 placeholder。概覽包含客戶、編號、代號、地址、款項、狀態、二訪建議／原因、來源與建立／更新時間。介面沿用 starter 的英文 UI 規範；demo 案件內容使用明確標示為虛構的中文文字。

## 驗證

最終結果：前端 client／SSR build、後端 Worker dry-run build、全部 workspace TypeScript、lint 與 Biome CI 通過。後端 7 個測試檔案共 65 個測試通過；Playwright 共 14 個 browser tests 通過（包含原 starter 的 9 個與新增案件的 5 個）。桌面列表、圖片頁與 390px 手機詳情截圖均已檢視。

```powershell
pnpm build:local
pnpm typecheck
pnpm lint
pnpm exec biome ci .
pnpm test
pnpm test:e2e
```

後端 build 另外在 apps/server 使用 `wrangler deploy --dry-run --config wrangler.local.jsonc`，未部署任何 Worker。Playwright 現在自動啟動 `dev:local`，不需 Cloudflare 認證；已運行時會重用本機 server。

測試涵蓋：Zod validation、真實 D1 constraints / foreign keys / indexes、分頁、同名搜尋、大小寫／地址搜尋、SQL/LIKE 字元、session 與指派權限、跨案件 image ID、disabled auth、私有 PNG bytes／headers、R2 adapter、hash 損毀與無配置 fallback。瀏覽器涵蓋列表／分頁／empty、全域搜尋、六個 tabs、blob 圖片／logout、agent 權限、loading／error／empty media 與手機排版。

下一步建議先補「案件新增／編輯與指派」，明確限制管理員寫入，再新增操作紀錄與 private image 上傳；之後才處理派單與回報工作流程。
