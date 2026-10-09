# 正式營運流程整合驗收

基礎版本：`7919557`（最新 dev Telegram Worker 相容性修復）。本次只使用本機虛構資料、fake Telegram 與 fake 圖片辨識；未部署任何遠端環境，也未 commit / push。

## 1–13：建檔、派單與回報

1. **正式流程**：Telegram 新案件圖片或人工完成圖片 → intake/resolver 或人工建檔 service → cases/case_media → 後台單筆／批量派單 → 外收收單群 → 外收回報群 → 人工選狀態 → 案件、分期及實收資料 → 四欄業務回報。
2. **兩種建檔入口**：`ManualCaseEditor` 保留人工輸入與完成圖片上傳；Telegram 圖片使用既有 album/private media/image extraction/intake resolver。兩者建立相容 cases/case_media。人工建檔不呼叫 AI。
3. **AI intake 獨立停用**：停用 intake route 即拒絕新收件。人工建檔、派單、回報、財務與權限不依賴圖片辨識。辨識只產生經 schema 驗證的提案；唯一配對可走 resolver，未配對案件仍由確認流程建立，低信心或歧義進 review。
4. **正式 route types**：`intake`、`collector_dispatch`、`collector_report`、`business_report`。舊 `intake_source`、`collector`、`report_destination` 保留歷史相容性並分別對應收件、收單、業務回報；舊 collector 不會被猜成回報群。
5. **群組代表外收**：精確 active chat/topic → active collector_report route → collector → active assignment。群組成員無須 Telegram identity；匿名群組發言也按 route 身份處理。綁定登入帳號時採用其個人 grants/deny，案件範圍仍強制限制在該 collector。
6. **Legacy identity**：保留 telegram_identities 表、歷史 migrations 與 legacy API；日常 UI 移除身分維護入口。新回報、callback 與分期工作流不查 Telegram user ID。
7. **回報照片**：在接收已知 collector_report 群的附件時即忽略，僅存 update_id、防重狀態及空 payload。檔案 ID、caption、照片資訊均不保存；不 download、不寫 R2/media/intake、不呼叫 AI。Telegram intake 圖片仍保留；停用舊 report route 並明確改設為 active intake 後，該目標立即按 intake 處理。
8. **OpenAI 使用點**：僅 Telegram source 的新案件圖片 job。enqueue 與 job selection/application 都限制 source；人工 intake 的辨識操作拒絕，前端不提供該操作。回報仍為 ManualClassifier／人工 Inline Keyboard，沒有 keyword/AI 分類。
9. **人工結果**：結清先詢問實收金額，成功記錄收款後同步 settled；無解 → unresolved；二訪 → follow_up。分期沿用 deadline/weekly/monthly 工作流、日曆月月底與最後一期 remainder。未來預計繳款不建立 payment。
10. **財務**：Telegram 結清使用 report UUID 作付款 idempotency key，沿用 createPayment 的 transaction 與 commission snapshot。15000 → commission 7500 / return 7500；settlement 初始 pending，不自動已回款。已有實收或 assignment 不因 Telegram 發送失敗回滾。
11. **群組設定 UI**：`/cases/telegram` 分四類管理名稱、chat/topic、collector、啟用、停用、編輯與時間。外收管理頁同時顯示收單／回報群摘要及設定入口。
12. **測試發送**：permission-checked testRoute 使用伺服器現有 token；畫面不接收 token。固定測試文字；失敗只回安全中文診斷，送達未知提示人工檢查。本機驗收使用 FakeTelegramClient，未向真實群組發送。
13. **立即生效**：每個 request/job 重查 route；pending outbound 使用更新後 chat/topic，inactive/type 不符立即拒絕。已 sending/送達未知 job 仍不盲目重送。每案各有 assignment/job；單筆派單也接上相同個別 outbound，scheduler 可修復 commit/queue 邊界且 unique assignment/job 不重複。

## 14–21：使用者、權限與登入

14. **資料模型**：既有 user 新增 active、permission_allow、permission_deny、permission_version；allow/deny 為由 strict schema 驗證的 permission key 陣列，沒有任意 permissions JSON。
15. **計算**：role default + explicit allow − explicit deny，deny 優先。case.view_own/view_all 決定案件 scope；case.view、audit_log.view 保留相容 alias。搜尋、批量、Excel、Telegram 管理與日誌都有獨立後端檢查；隱藏 UI 只改善操作體驗。
16. **防鎖死**：使用 expectedVersion 與 D1 條件寫入，在同一 transaction 檢查其他 active permission manager。最後一位不能停用、移除權限或更改 Email；並行降權測試確認仍有一位。拒絕的更新不刪除 session。權限 audit 包含 actor/target/前後 role、active、allow/deny。
17. **Email 白名單**：`/cases/users` 建立並啟用的 user 才有登入資格；新增姓名、Email、角色及個人權限。Email trim/lowercase；Gmail +alias 保持不同帳號。normalized unique index 阻止大小寫重複。
18. **OTP gate**：authHandler 在 better-auth 前查 user active，未知／inactive 返回「此帳號未被授權使用本系統。」；不寄信、不產生 OTP、不建立 user。verify 同樣重新檢查 allowlist。
19. **停用即失效**：管理 API 刪除該使用者 sessions；每個 getSession 重新查 active/banned 與 persisted session。Cookie cache 不作授權來源，現有 session 下一 request 即拒絕；API-key owner 也檢查 active/banned。
20. **第一位 admin**：本機 demo seed 使用明確虛構帳號。乾淨本機可執行 `node scripts/bootstrap-admin.ts admin@example.test --local`；只在沒有 active permission manager 時插入，沒有 remote 模式，也沒有公開 bootstrap endpoint。遠端 release 必須由受控 seed 初始化已核准 admin，後續日常帳號用 UI 管理。
21. **公開註冊關閉**：emailOTP disableSignUp + user creation before-hook 拒絕建立未知 user。auth surface 只保留 OTP send/verify、get-session、sign-out；auth library 的其他管理入口不公開。登入 UI 不提供註冊或建立帳號；ADMIN_EMAILS 不再在 runtime 自動升權。

## 22–27：安全診斷與資料升級

22. **System Log**：新增 system_logs，含 timestamp、level/category/event/status、safe_message、case/collector/job/route/user references、correlation、duration/retry/error、handled_status/by/at/note。與 audit_logs 分開，財務歷史保持原 schema。
23. **UI**：`/cases/system-logs` 有今日摘要、最近錯誤、中文快捷篩選、日期/等級/類型/處理狀態、搜尋、分頁及安全詳情。可追蹤案件、外收、群組設定、使用者；有 AI job 時可連到 intake/review。財務明細仍由關聯案件的既有收款頁追蹤。
24. **Sanitization**：不保存 raw provider response、stack、圖片 bytes、URL、Cookie、Authorization、OTP 或 API key。System Log 寫入 strict schema，任意訊息含憑證／URL／驗證碼／純 Telegram token 模式時整段隱藏；audit-to-system trigger 只寫固定安全訊息與允許的代碼。登入事件不記錄 Email 原文。診斷包含 DELIVERY_UNKNOWN、API_400/403、ROUTE_NOT_FOUND、OTP_SEND_FAILED、EMAIL_NOT_ALLOWED、USER_INACTIVE、PERMISSION_DENIED 等。
25. **Retention**：cleanupSystemLogs 僅清 system_logs：info 30 天、warning/error 90 天、critical 180 天。Telegram scheduler 呼叫 cleanup；函數亦可被獨立排程使用。Audit/payment/settlement 不套用短期 retention，處理標記只更新 handled 欄位，不改原事件。
26. **Migrations**：0015 新增 user 欄位、system_logs、route name/type；0016 新增 route 並行衝突與安全系統事件 triggers；0017 normalize Email 並加入唯一索引。歷史 identity、assignment、finance、media、outbound 資料均保留。
27. **主要修改檔案群**：DB schema/migrations；auth/context/permissions/user-management；system-log/system-logs；Telegram route/principal/report/status/payment/installment/processing/outbound；單筆／批量派單銜接；private storage 日誌；Telegram intake source 限制；使用者／日誌／Telegram UI、導覽與搜尋權限；本機 bootstrap/seed；backend/browser fixtures 與測試。packages/ui 未修改，Telegram Worker redirect fix 保留。

## 28–32：驗證與環境邊界

| 驗證 | 結果 |
|---|---|
| 完整 backend | PASS：226/226，18 個測試檔；包含 Miniflare D1/KV/R2、OTP/權限/route/財務/防重及 populated migration 驗證 |
| 完整 browser/mobile | PASS：38/38，0 retries；最終日誌遮罩補強後相關 operations/mobile 再驗 3/3 |
| TypeScript | PASS |
| lint | PASS |
| Biome | PASS：236 個檔案，唯讀 CI 檢查 |
| build | PASS |
| Worker dry-run | PASS（local config，未部署） |
| foreign_key_check | PASS：本機 D1 0 違規；populated migration 測試 0 違規 |
| Secret diff scan | PASS：已知實際 secret 比對 0 命中；Telegram token／OpenAI key 格式掃描 0 命中 |

28. Backend 完整測試 226/226 通過；以最後程式及全部 18 migrations 驗證。結清誤選尚未實收時可更正；更正後到達的舊收款請求由 transaction guard 拒絕，不建立 payment/settlement。
29. Browser/mobile 的歷史 route fixture 已改成更新既有 collector_report route，而非建立衝突路由。最終驗證不在測試期間改程式，避免 dev HMR 中斷登入連線。
30. 所有檢查均本機；真實 Telegram/Resend/OpenAI 與 remote R2 未作本次驗證。本次不能視為已完成 production 真實整合。
31. Secret 檔保持 gitignored；未修改 token/key，最終僅回報掃描結果、不列 secret 值。先前 staging 設定／文件／腳本仍保留於工作目錄。
32. 沒有 production 變更、遠端 migration、部署、webhook 設定、commit 或 push。HEAD 保持 7919557。

## Release / recovery 注意事項

- 先備份目標 staging D1，再套用 migrations、確認 foreign keys 與既有路由／outbound 歷史。0015 使用 [D1 支援的 defer_foreign_keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)，而非關閉 foreign keys；已演練有 parent route references 的升級。
- 0017 遇到大小寫／空白正規化後重複 Email 時會拒絕升級，必須先由管理者明確選擇帳號；不得猜、合併登入身份或移除 Gmail alias。
- 舊 user activation 預設保持啟用。Release 前在使用者清單審核歷史 Email，停用不應授權的帳號，確認至少一位核准權限管理者。
- 若需回復，使用 upgrade 前備份／D1 recovery 還原整體 schema 與資料；不要 drop 財務、audit 或 identity 表，也不要把舊 public signup 程式對著新營運資料庫啟用。
- Staging 真實 smoke 應涵蓋四種 route、不同群組成員 callback、忽略回報照片、15000 實收/7500 尚未回款、三種分期、單筆／批量逐案派單、route 即時修改、停用帳號/session、權限改動與 safe system logs。Production 需另行核准切換。

## 本機驗收證據對照

| 使用者驗收項目 | 主要證據 |
|---|---|
| 1–4 建檔入口／AI 限制 | image-extraction、finance、intake、operations backend；finance、image-extraction、intake browser |
| 5–12 回報圖片／群組身分／指派 scope／衝突 | telegram、operations backend；telegram、image-extraction browser |
| 13–20 人工結果／分期／實收／snapshot／防重 | telegram、finance、operations backend；reports、finance browser |
| 21–30 個別派單／四欄回報／retry／route 即時設定 | telegram、bulk-assignment、operations backend；bulk-assignment、telegram browser |
| 31–42 角色與個人 grants／deny／防鎖死／audit | operations、case-management backend；operations、bulk-assignment browser |
| 43–56 白名單／OTP／session／正規化／無公開註冊 | auth-modes、dev-otp、operations backend；auth、operations browser |
| 57–73 安全日誌／查詢／處理／權限／mobile | operations、telegram、image-extraction backend；operations、telegram browser；mobile screenshots |

以上為本機服務與 fake provider 驗收；外部供應商的實際成功率、權限及 webhook 設定需另於 staging 真實整合確認。

最終執行紀錄保存在 gitignored `.secrets/operations-artifacts/`：backend-release、browser-release、browser-log-final、ts-release、lint-release、ci-release、build-release、worker-release、fk-release。工作目錄保留待確認的程式變更，git index 為空。
