# 後台 UI 與 Telegram Bot 管理本機驗收

本次採自行設計的深灰／藍色 SaaS 介面，不使用外部模板或金色主題。未 commit、push 或部署。

## 介面範圍

- 登入：深色中央卡片、系統識別、Email allowlist + OTP，無公開註冊或 Telegram Login。
- Desktop：固定分類 Sidebar、權限控制導覽、使用者角色與登出。
- Mobile：底部導覽與「更多」Sheet、案件 Card List、批量操作列、可捲動 Dialog。
- 案件、收件、待確認、地區調度、外收人員、財務、Telegram、使用者與權限、系統日誌共用設計語言。
- 統一 tokens、品牌、頁面 shell、狀態色、按鈕、卡片、輸入框與 modal。未修改 packages/ui。

## 最小 API 與資料補充

- Telegram Bot 管理：安全清單、getMe 驗證綁定、同 Bot token 輪替、啟停、測試。
- telegram_bot.manage 專用權限；前端顯示仍搭配後端 enforcement。
- AES-GCM token 加密；TELEGRAM_TOKEN_ENCRYPTION_KEY 必須透過環境 secret 設定，未修改本機 secret 檔。
- viewer 角色、安全整合狀態、有效權限與作廢列表讀取支援。
- migrations：0020_real_thena、0021_sweet_surge、0022_bot_outbound_guard，僅本機套用。
- 停用 Bot 明確 BOT_DISABLED；保留 assignment、不送訊息、不自動重試，不影響其他 job。System Log 不記錄 token 或 provider 敏感內容。
- 保留 legacy webhook；未建立多 Bot inbound webhook／update_id 隔離，不應宣稱已完成多 Bot inbound 整合。

## 驗證

Backend 248/248；相關 browser/mobile 7/7。完整 browser run 為 41 通過／1 等待條件失敗；修正測試等待實際狀態後，intake 4/4 重跑通過。未再執行全套，沒有尚未處理的失敗。
TypeScript、lint、Biome、build、Worker dry-run 通過；本機 foreign key 0 違規。
最終 secret scan 60 檔，沒有疑似 secret 或 tracked secret 檔；git diff --check 通過。
Responsive 覆蓋 1366、1440、1920、375、390、430，11 個主要頁面。

## 仍需 staging 驗證

真實 getMe／token 輪替、Worker encryption secret、Bot 啟停與 route 綁定、真實 outbound 圖片派件、OTP 寄信、private R2 與實際裝置操作。
本機 external provider fixture 不代表真實 Telegram 或 production 驗收。
既有 22 個 staging untracked 檔未修改、刪除或加入 Git。
