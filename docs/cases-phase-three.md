# 委外案件管理：第三階段回報流程

使用 `pnpm dev:local` 啟動本機 D1 / R2 與既有 OTP 登入。此階段沒有 Telegram webhook、OpenAI、AI 自動分類、payment ledger、分期排程或正式 deployment；所有範例及測試資料均為虛構。

## Reports schema

`packages/db/src/schema.ts` 定義 reports：id、case_id、assignment_id nullable、collector_id nullable、created_by_user_id、content、status、revisit_status nullable、revisit_reason nullable、payment_detected default false、payment_amount nullable、source、created_at、updated_at，以及 optimistic concurrency version。

四項關聯皆有 foreign key；案件／時間、指派、外收人員均有索引。CHECK 約束限制內容、狀態、來源、二訪值、付款金額與日期。金額為整數 TWD，付款標記不會建立任何財務帳。

回報 status：cannot_find、follow_up、installment、settled、unresolved、needs_review。二訪值獨立為 recommended、observe、not_recommended、not_needed。舊案件的 pending / not_required 保留兼容，新回報不接受這兩個舊值。

## 共用 API 與授權

- `reports.create`：建立回報；source 由後端按政策設為 admin 或 collector_portal，前端不能指定來源、操作者或指派識別碼。
- `reports.list`：讀取案件全部回報，依建案時間與 id 由新到舊。
- `reports.edit`：編輯內容與分類欄位，固定案件、操作者、原始來源與建案時間。
- `cases.lookup`：安全的精確姓名／代號／案件編號查詢。

`permissions.ts` 加入 report.view / report.create / report.edit。admin / manager 可建立、閱讀、編輯其政策範圍的回報；user 可閱讀及建立自己目前有效指派案件的回報，預設沒有 report.edit。API 同時要求 case.view 與對應 report permission。案件存取以啟用中的 collector 及有效 assignment 為準；解除或改派後，舊外收人員不能讀取或再回報該案件。

`reports.ts` 的 createReport 是可共用的服務，會重新驗證輸入、權限與範圍。未來已驗證身分的 Telegram / API adapter 可傳入受信任的 source；本階段沒有建立這些 adapter。不能用公開前端欄位偽造 telegram source。

## 狀態與歷史

`report-classification.ts` 集中定義映射：cannot_find / follow_up → follow_up，installment → installment，settled → settled，unresolved → unresolved；needs_review 不更新案件 status。付款標記不參與狀態推論。

新增回報、案件狀態／二訪摘要、audit 在同一個 D1 batch 內寫入；版本衝突回傳 409。一般帳號的有效指派與啟用狀態也在更新 SQL 再次檢查。任何 audit 或資料庫寫入失敗整批 rollback。

回報保留當時 assignment 與 collector 識別碼，不會跟著改派移動。每筆回報各自保存二訪建議與原因，新回報不修改舊內容。最新回報的非 null 二訪建議同步到案件摘要；null 表示保留目前建議。編輯最新回報同步摘要，編輯較舊回報只更新該歷史紀錄，不覆蓋目前摘要。編輯需同時提供 report version 與 case version，以避免並行更新互相覆蓋。

`report.created` / `report.edited` audit 掛在案件上，metadata 只記錄 reportId／變更欄位名稱，不記錄回報全文或付款金額。

## 同名案件

`case-lookup.ts` 使用帶參數的 NOCASE 精確查詢，先套用 caller 案件範圍。回傳 matched、not_found 或 ambiguous 與候選的 id／姓名／代號／案件編號；任何欄位有多筆匹配都不自選。候選最多 50 筆，超過時 truncated=true，仍回傳 ambiguous。上層須用代號／案件編號縮小或要求選擇，再用明確 caseId 提交回報。

## 未來分類接口

`report-classification.ts` 提供 ReportClassificationProvider、ManualClassifier、classifyReport，以及 reportClassificationSchema。provider 回傳 unknown，統一通過 schema validation 才可使用。接受 status、revisit_status、revisit_reason、payment_detected、payment_amount、confidence；拒絕額外欄位、無效 enum、非整數金額、不一致付款標記及 0–1 以外 confidence。

目前服務只使用 ManualClassifier；未新增 OpenAIReportClassifier、金鑰、API 呼叫或自動推論。provider 不持有資料庫 context，不能直接執行 SQL；未來低信心結果的人工確認政策需在啟用 AI 前另行設計。

## UI 與驗證

案件詳情的 Report history 提供建立／編輯 dialog、狀態 badge、回報人／時間／內容、二訪建議、收款觀察、金額與來源。一般外收人員沒有編輯按鈕，API 也拒絕編輯。沿用 shadcn/ui，包含 loading、empty、error 與 mobile layout。

`apps/server/tests/reports.test.ts` 覆蓋狀態映射、權限與指派範圍、immutable 輸入、付款與 provider validation、歷史保留、並行衝突、audit rollback、同名 ambiguity 與參數安全。`apps/web/e2e/reports.spec.ts` 以真實本機 OTP 登入，驗證管理員建案／回報／編輯／摘要／audit，以及外收人員建立回報與跨案件拒絕。

本機管理帳號新增 `phase3-admin@example.test`，用於避免不同 browser specs 的 OTP 互相干擾。這是本機合成帳號，沒有真實憑證。
