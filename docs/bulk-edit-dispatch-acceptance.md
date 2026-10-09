# 批量編輯與私人圖片正式派件驗收

基準：dev / 8390af17812fbf7cc0fe3ea4ec92aef6b824b83f。驗收只使用本機虛構資料、Miniflare D1/R2 與 fake Telegram；沒有 commit、push、staging/production 部署。

1. **批量編輯**：既有列表 checkbox 支援目前頁面全選與已選取筆數。有編輯／作廢權限時可選已委外案件；正式批量委外仍逐案套用未委外規則。Dialog 只送明確勾選的 region／collectorId；未選欄位保持原值。提供只補空白、明確覆蓋、原因、逐案成功／跳過結果。批量刪除是作廢，沒有 physical delete。
2. **歷史外收**：空白補登建立 record_type=historical；已有歸屬的人工覆蓋建立 correction 並保存 corrected_from_id，關閉前任有效 assignment。保持原派單時間（有前任時）；空白補登只有補登時間，不推測真正歷史派件日期。
3. **Action 分離**：bulkEdit 只執行人工修正 transaction 與逐案 audit，沒有 outbound、payment、settlement 或 business report 呼叫。formal assign/reassign/bulkAssign 才能排 assignment_dispatch。queue、scheduler recovery、outbound validator 及 DB trigger 都要求 record_type=assignment，封住原本 correction 被 scheduler 補送的缺口。
4. **正式派件**：每案 active assignment → 自己 collector 的唯一 active collector_dispatch（或保留的 legacy collector）route → 獨立 outbound。單筆找不到 route 時保留委外，回傳 telegramWarning 並寫安全 ROUTE_NOT_FOUND；不送其他 collector。正式重新委外保留舊 assignment，建立新 assignment／job。
5. **多圖**：private storage 讀 bytes 並比對 SHA256；不產生 public URL。0 張沿用文字，1 張 sendPhoto，2–10 張 sendMediaGroup；超過 10 張分組，尾組單張使用 sendPhoto。每組都帶案件編號、代號、姓名、地區 caption。依 [Telegram Bot API](https://core.telegram.org/bots/api#sendmediagroup) 的 multipart attach 機制上傳。初次處理時保存圖片 snapshot，成功一組即 checkpoint message IDs。確定拒收的 429／可重試錯誤接續未送組；DELIVERY_UNKNOWN、失去 lease 或成功後 checkpoint 失敗不盲目重送。部分已送後 route 改變會停止，避免一案分送兩個群。
6. **Migrations**：0018_next_rattler.sql 新增 cases.voided_at/by/note 與 telegram_outbound_jobs.dispatch_state；0019_dispatch_guards.sql 容許有原因的 historical 補登，保留原 correction 前任約束，禁止歷史 assignment 建立 dispatch job，阻止已作廢案件建立新 assignment/report/installment/payment。只套用本機。未改既有財務計算、OTP/allowlist、permission merge、system log sanitizer 或 collector_report 規則。
7. **修改檔案**：見下方清單；packages/ui 與全部先前 staging untracked 檔案未修改。
8. **API/service**：新增 cases.bulkEditPreview、bulkEditCollectors、bulkEdit、bulkVoid；bulkEdit 使用 case.edit，外收修正再驗 assignment.correct，逐案重新讀取有效使用者與權限、檢查 collector active、case version/狀態。相同 batch/case/hash 重送讀 audit 結果，不重複更正；改變 request 的重送拒絕。bulkVoid 使用 case.delete、明確確認與原因，保留所有歷史，取消 pending 派件，正常列表不顯示作廢案件。財務既有回款操作仍保留。
9. **UI**：批量編輯、批量委外、批量刪除；顯示已有外收筆數、只補空白預設、覆蓋確認、中文安全 skip reasons、mobile dialog。派單歷史區辨識 historical／correction；缺 route 有中文警告；詳情標記已作廢。每筆 audit 保存 actor/case/選定欄位/before/after/原因/時間；原因套用既有敏感字串遮罩。
10. **結果**：完整 backend 240/240（19 files）；相關 browser/mobile 8/8、無 retries；TypeScript、lint、Biome（243 files）、build、Worker dry-run PASS；本機 foreign_key_check 0 違規；secret diff scan 29 files 0 命中。第一次 FK 與 browser 同時操作 local SQLite 遇到 lock，測試完成後重跑通過。執行紀錄在 gitignored .secrets/bulk-*.log。
11. **歷史 outbound=0**：測試 100 筆補登後執行 scheduler recovery，該 100 案 outbound 精確為 0；單筆 correction、只補空白、覆蓋同樣不發 TG。
12. **正式派件**：本機 formal assign/reassign/bulkAssign 每案獨立 assignment/job；1/2/3/11/20 張全部送出、兩組間 429 僅重送剩餘組、未知送達不重送。Workers multipart HTTP fixture 驗證每個 attachment、chat/topic 與回傳 message IDs。此 PASS 不代表已向真實 Telegram 發送。
13. **風險**：Telegram 與 D1 沒有跨服務 transaction，未知送達需要人工核對；作廢／改派不能收回已送出的圖片；pending snapshot 的原圖被刪除或損壞時會停止並記錄失敗，不猜測／略過圖片。歷史有效 assignment 在正式批量未委外規則中仍視為已有歸屬，需要正式重新委外，不能偷偷當成空白。
14. **Commit**：本機檢查可通過 commit review，但本次沒有 stage/commit/push。必須逐檔選取此功能變更，排除先前 22 個 staging untracked 檔案與所有 secret 檔；不可 git add .。HEAD 保持基準。Production readiness 仍需真實 staging 驗收。
15. **Staging 真實待驗**：Worker 到 Telegram 的 sendPhoto/sendMediaGroup multipart；1/2/3/11 張與大量照片、PNG/JPEG/WebP／接近 5 MiB 圖片的接受度、R2 binding、Worker memory/lease/time limits；真實 chat/topic、三案獨立派件／改派正確群；真實 429、部分送達與未知送達人工核對。不要使用 production 或真實客戶資料。

## 修改檔案

- Backend：packages/api/src/bulk-case-edit.ts、telegram-dispatch-media.ts、telegram-client.ts、telegram-outbound.ts、telegram-processing.ts、assignment-outbound.ts、bulk-assignment.ts、case-management.ts、case-access.ts、case-lookup.ts、cases.ts、index.ts。
- Frontend：apps/web/src/components/cases/bulk-edit-dialog.tsx、bulk-assignment-dialog.tsx、assignment-panel.tsx、audit-timeline.tsx；apps/web/src/routes/cases/index.tsx、$caseId.tsx。
- Database：packages/db/src/schema.ts、0018/0019 SQL、對應 snapshots／journal。
- Tests：apps/server/tests/bulk-edit-dispatch.test.ts、telegram-client.test.ts、telegram-api-fixture.js；apps/web/e2e/bulk-edit.spec.ts、bulk-assignment.spec.ts。

## 升級注意

先於獨立 staging 備份 D1，再完整套用 migrations 與檢查 FK／舊委外及 outbound 歷史；已 sent 或 DELIVERY_UNKNOWN 的歷史 job 不自動重發。若回復，恢復整體 schema/data 備份，勿單獨刪除 assignments 或財務紀錄。本機曾在草稿 0019 已套用後修訂 historical guard，已同步本機 trigger；新的空白 DB 與完整 migrations 由 backend 驗證通過。
