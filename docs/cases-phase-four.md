# 委外案件管理第四階段：統一人工確認

此階段只使用本機 demo D1 / R2、合成帳號與虛構資料。`pnpm dev:local` 開啟 http://localhost:3000/cases；待確認中心為 `/cases/reviews`。沒有 Telegram webhook、OpenAI、OCR、財務帳、分期排程、歷史圖片正式匯入或 Cloudflare deployment。

## Schema

`review_items` 包含需求的所有欄位：id、review_type、entity_type、entity_id nullable、case_id nullable、status、priority、source、proposed_data、reason、confidence nullable、created_by_user_id nullable、resolved_by_user_id nullable、created_at、resolved_at nullable。

額外欄位為 confirmed_data、dedupe_key、version、write_token。proposed_data 與 confirmed_data 分開保存，resolver 永不修改原始提案。priority 為 low / normal / high；status 為 pending / approved / corrected / rejected；source 為 manual / ai / telegram / historical_import。

D1 有案件及使用者 FK、唯一 dedupe index、狀態／類型／時間、案件／時間與 entity 索引，以及 enum、JSON、confidence、resolution consistency CHECK。JSON 的真正欄位驗證在 `review-contract.ts` 的 strict discriminated union，不能用任意 JSON 指定 SQL 或正式欄位。

## 回報進入 queue

`reports.ts` 在回報為 needs_review 時，於同一個 D1 batch 保存回報、原始內容與分類提案、review.created audit。案件 status 與二訪摘要均不先同步。編輯有 pending classification 的回報不能繞過確認：回報維持 needs_review，修訂分類建立另一份版本快照。

Migration 將既有 needs_review 回報納入 queue，保留既有案件摘要，不回溯猜測第三階段之前的狀態。若同一回報已有其他提案或後續修訂，舊版本 review 的核准會因版本不符回傳 409；管理員可以拒絕過時項目，再處理最新提案。

## 共用服務與 APIs

`review-service.ts` 集中處理 enqueue、讀取與 resolve，未來 authenticated adapter 可使用 createReview 的 typed input 與受信任 source。瀏覽器 create API 固定 source=manual，不能偽造 ai / telegram 或提供任意 JSON。

- reviews.create：管理權限者可提交手動測試提案；不執行任何 AI 或 OCR。
- reviews.list：預設 pending，支援類型、狀態、搜尋與分頁，優先列出 high priority。
- reviews.pendingCount：依使用者可查看範圍計算待確認數。
- reviews.detail：原始提案、可見候選、目前案件版本與最終確認。
- reviews.resolve：approved / corrected / rejected。

Resolver 重新驗證 schema、review.resolve、case.view 與目標資料權限；CASE 與 report 版本 guard 防止覆蓋並行更新。單一 D1 batch 內更新正式資料、寫 audit、結束 review；任何錯誤整批 rollback。只有 pending 狀態可寫入，guard 使用每次唯一 token，重複或並行的相同決定只產生一次正式更新與 audit。已結束項目的不同決定或不同確認值回傳 409。

approve 使用原始提案；變更提案必須 corrected。needs_review 不是最終分類，不能直接核准，需要人工選擇正式 status。reject 不修改案件或回報，也可以結束因版本變動而過時的提案。

Report classification 依第三階段共用映射同步 status；cannot_find → follow_up，needs_review 永不作正式狀態。較舊回報的核准只更新該回報，不覆蓋較新案件摘要。payment_detection 只更新回報的付款觀察，沒有 ledger 或金融副作用。

## Case match

create API 只接受姓名／代號／案件編號 query。後端使用 lookupCase 查詢，必須是未截斷的 ambiguous 結果，才保存候選 ID。client 不能提交候選清單。

Resolve 僅接受儲存的候選，逐次重新檢查案件查看範圍；詳細 API 不洩漏沒有權限的候選。選定結果存入 confirmed_data.selectedCaseId 與 review 的 case_id。這是 intake 的確認結果，不會把既有回報或圖片擅自搬到另一案件；未來 adapter 必須消費這份已確認結果。

## Image extraction

`review-contract.ts` 的 extractionSchema / ImageExtractionProposal / ImageExtractionReviewProvider 保留未來辨識接點。欄位為 code、customer_name、address、amount_due，限制字數與整數金額；provider 回傳 unknown，須通過 schema 才可提交。

目前只接受針對既有案件的手動測試提案。人工可逐欄修改，核准後只更新四個允許欄位，不能改 id、case_no、created_at。proposed_data 與 confirmed_data 都保留，沒有辨識服務、圖片 bytes 或正式歷史匯入。

## Permissions / Audit

`permissions.ts` 增加 review.view / review.resolve。admin / manager 依既有政策可處理；一般 user 預設兩者都沒有。新增 reviewer 政策展示可擴充的「只處理自己有效指派案件」權限，沒有新增角色管理 UI，也沒有替一般外收帳號自動授權。

核准 classification / payment 另需 report.edit；image extraction 需 case.edit；case_match 需 case.view。所有 API 在後端檢查，前端隱藏按鈕只是顯示邏輯。範圍有限的 resolver SQL 也再次檢查有效指派與 collector 啟用狀態。

Audit 記錄 review.created / approved / corrected / rejected，包含 user_id、created_at、reviewId、entityId。案件相關事件掛在案件 timeline；尚未選定案件的事件掛在 review entity。metadata 不保存圖片 bytes、回報全文、API key 或 OTP。

## UI / 測試

Workspace 導覽顯示 Pending review 數量；列表提供類型、狀態、客戶／案件、原因、confidence、來源、时间、priority。確認畫面保留原始提案、提供逐欄修改、候選選擇與核准／修改後核准／拒絕；已處理項目顯示最終值及處理人。沿用 shadcn/ui，包含 loading / empty / error 與手機版面。

`reviews.test.ts` 覆蓋 needs_review 不先同步、建立、三種決定、未授權、並行／重複請求、stale version、編輯繞過阻擋、候選權限、圖片逐欄修改、收款觀察、audit rollback 與搜尋／分頁。`reviews.spec.ts` 驗證真實瀏覽器流程、權限拒絕與 mobile layout。使用本機合成 phase4-admin@example.test 避免其他 specs 的 OTP 衝突，未新增真實憑證。

本機 Playwright suite 使用單一 worker，避免多個 specs 共用 demo 身分時互相消耗一次性 OTP；未變更實際登入流程。
