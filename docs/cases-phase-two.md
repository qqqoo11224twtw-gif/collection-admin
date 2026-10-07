# 委外案件管理：第二階段

本階段只使用本機 D1 / R2 模擬器與虛構資料，保留 starter。使用 `pnpm dev:local`，前端 http://localhost:3000/cases，後端 port 4000。沒有 Telegram、OpenAI、正式部署或真實客戶資料。

## 資料模型

- `collectors`：外收人員、唯一代號、啟用狀態，以及可選的登入使用者連結。不含 Telegram 識別碼。
- `assignments`：案件、外收人員、指派人、指派時間、解除時間與備註。改派先結束舊紀錄，再新增紀錄；解除只結束紀錄。部分唯一索引確保每案最多一筆有效指派。
- `audit_logs`：使用者、事件、實體、白名單 metadata 與時間；資料庫 trigger 禁止修改或刪除紀錄。
- `cases` / `collectors` 增加版本與內部寫入標記，使用 D1 atomic batch 與版本檢查避免並行更新覆蓋、重複指派或錯誤 audit。衝突回傳 409，重新整理後重試。

舊 `assigned_agent_id` 已透過 migration 轉為 assignment 快照；系統指派人與備註明確標示原始操作者及時間未曾記錄。快取保留，但案件權限與歷史都以 assignments 為準。建案編號由後端生成，編輯不能變更 id、編號、建案時間或來源。

## 權限

`packages/api/src/permissions.ts` 定義十項 permission 與可擴充角色政策。admin 擁有全部權限；manager 擁有案件管理權限但不能管理外收人員；user 只有指派範圍內的 case.view / media.view；未知角色沒有授權。

`case-access.ts` 統一檢查案件範圍。一般帳號必須連結啟用中的 collector，且有有效 assignment；停用 collector 立即停止其案件存取。前端依後端授權隱藏操作，所有 API 仍獨立驗證 permission 與案件範圍。

## 私人圖片

`case-media-management.ts` 在讀取上傳內容前驗證登入、案件權限與 Origin。每次最多 5 張，每張最多 5 MiB，每案最多 100 張；PNG / JPEG / WebP 必須符合宣告類型與檔頭驗證。伺服器產生 SHA-256、獨立 storage key，以及綁定案件的 metadata。

`case-storage.ts` 的 read/write/delete adapter 使用本機私有 `CASE_BUCKET`；demo fixture 可由測試 adapter 提供。未來設定 `CASE_STORAGE_MODE=r2` 並接入 private CASE_BUCKET 即可使用 R2 adapter，正式 binding 尚未建立。圖片沒有 public URL；讀取 API 依序驗證登入、media.view 與案件範圍，再回傳 bytes，使用 no-store / nosniff。

上傳資料庫寫入失敗會清除已寫入物件。刪除先原子移除 metadata 與寫入 audit，再清理物件；若清理失敗回傳 cleanupPending，圖片已無法透過 API 存取，但需後續清理孤立物件。本階段沒有背景垃圾清理服務。

## 操作紀錄與 UI

紀錄建案、編輯、指派、改派、解除指派、圖片上傳、排序、刪除，以及外收人員新增／編輯。metadata 僅保存欄位名稱、識別碼、數量及版本，不保存秘密、OTP、圖片內容或客戶欄位值。案件詳情顯示最近 100 筆事件。

新增／編輯案件與指派使用 dialog；外收人員頁提供新增、編輯、啟用／停用及登入帳號連結；圖片區提供多張上傳、排序、確認刪除；派單紀錄與操作紀錄已接入真實本機資料。

## 驗證

`pnpm test` 包含建案、編輯、immutable 欄位、並行版本衝突、D1 rollback、完整指派歷史、權限拒絕、圖片格式／大小、SHA-256、storage 補償與 append-only audit 測試。`pnpm test:e2e` 包含管理流程、私人圖片操作與一般帳號拒絕流程，以及第一階段回歸。另執行 typecheck、lint、ci 與 build:local；build:local 不會部署。
