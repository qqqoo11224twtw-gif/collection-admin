# 批量 AI OCR：本機實作與驗收

## 架構與變更

本次基於已恢復的 GitHub dev / 4b78f25 工作目錄開發；正式站存在未取回的較新修改，因此本變更不能直接覆蓋線上版本。未 push、未部署、未執行遠端 migrations，未修改既有業務資料。

原系統為 pnpm monorepo：TanStack Start/React 前端、Hono/oRPC 後端、Drizzle/D1、私有 R2 案件圖片、KV、Cloudflare Workers（API/Web）。批量流程在 apps/web/src/routes/cases/bulk-create.tsx 與 packages/api/src/bulk-case-create.ts；原流程已具備預覽驗證、同姓名代號重複提示、批次/列 idempotency、逐列建立、圖片附件與派件。資料仍寫入原 cases，不新增另一個管理系統或身分證資料表。

權限沿用啟用帳號與持久 session：case.create、media.upload、media.view 才能呼叫 OCR。建檔仍由原權限服務檢查；指定外收另查 assignment.create/bulk。

主要變更：

- packages/api/src/bulk-ocr-contract.ts：欄位契約、22 縣市正規化、保守棄答與證據過濾。
- packages/api/src/bulk-ocr-service.ts：受保護的雙引擎管線、格式/串流大小檢查、固定目的地、超時、每人每分鐘 20 次原子 D1 限流。
- packages/api/src/bulk-ocr-receipt.ts：綁使用者與圖片雜湊、有效一小時的 HMAC 審核憑證。
- packages/api/src/bulk-case-create.ts：OCR 列人工確認檢查、相同圖片批內去重；保留舊手動列相容性及原有批次防重送。
- apps/server/src/index.ts：POST /api/cases/bulk-ocr、無快取、CORS 自訂標頭。
- apps/web/src/components/cases/bulk-ocr.tsx：選圖/拖曳、同意傳送、EXIF 方位正規化與中繼資料移除、上傳進度、原圖及欄位證據/區域。
- apps/web/src/routes/cases/bulk-create.tsx：逐張辨識填入現有列、獨立失敗/重試、人工核對/全部確認、編輯後撤銷確認；OCR 原圖不自動作為永久附件。
- apps/server/env.d.ts、packages/api/env.d.ts：設定型別。
- apps/server/tests/bulk-ocr.test.ts、packages/api/tests/bulk-ocr-rules.test.ts：整合與獨立規則測試。
- scripts/test-bulk-ocr.mjs、scripts/evaluate-bulk-ocr.mjs、package.json：測試與準確率計算入口。
- apps/server/.bulk-ocr.env.example：無密鑰設定範本。

## 技術選擇與限制

採 Google Cloud Vision DOCUMENT_TEXT_DETECTION（zh-TW 提示）取得 OCR 文字及字詞 polygon，再讓 OpenAI Responses 視覺模型獨立讀同一張圖，最後以程式精確比對文字。OpenAI 不接收 Google 的文字猜測，減少複誦同一個錯字的影響，但兩個引擎仍可能同時看錯，絕不把一致性當作準確率。初始可評估 gpt-5.4-2026-03-05；實際最佳模型必須由你的標準答案測試集決定，未驗證其台灣證件專用準確度。

普通 OCR 單獨使用欠缺姓名/暱稱/戶籍語意；VLM 單獨使用可能猜字。台灣證件專用商業服務尚未取得契約、安全條款及實際樣本對比，不假設其優於雙引擎。第三個引擎可以日後作爭議件複核，但目前爭議直接留白交人工，不以多數決代替真值。

流程：瀏覽器解碼/尺寸檢查→依 EXIF 方向輸出無損 PNG/移除 metadata→逐張受保護上傳→Google 全版文字區域偵測→VLM 原圖語意判讀→精確文字交叉比對→原表格預覽→人工確認→原建檔 API。不依賴固定區塊或固定裁切座標，不做生成式修補、猜字補全或強制銳化。

辨識只保留姓名、暱稱、縣市的最小原文證據；不回傳完整地址、身分證號或 OCR 全文。Google 可定位整個欄位文字時附原圖 polygon 像素座標；跨多個詞的欄位可能沒有完整區域，目前顯示座標與可放大的完整原圖，尚未實作區域疊圖。畫面地區沿用原系統完整名稱（彰化縣）；簡稱輸入可正規化。新竹/嘉義缺縣市時刻意留白。

目前只做尺寸/可解碼檢查與 VLM 品質/多人物判斷；沒有已校準的模糊度門檻、自動傾斜校正或區域二次放大辨識。這些需以樣本評估後擴充，不能宣稱各種模糊/手寫拼貼都可精準辨識。

每次單張最多 5 MiB，最大 4000 萬像素；無損 PNG 若超限要求拆圖，不偷偷壓縮細字。瀏覽器逐張處理，同一張失敗繼續下一張。Google 超時 25 秒、OpenAI 45 秒、前端 90 秒，沒有自動付費重試。Workers 記憶體 128 MB，故不在 Worker 解碼/跑大型 OCR 模型、不合併 20 張為一個記憶體請求；正式負載與計畫 CPU 限制仍需 staging 驗證。

## 隱私與設定

預設 BULK_OCR_ENABLED 與 BULK_OCR_PRIVACY_APPROVED 均未啟用。只有管理者確認資料處理授權、供應商政策/契約、跨境傳輸與適用保留設定後才填 true；UI 另要求每次操作同意 Google/OpenAI 的明示傳送。沒有在本輪向供應商傳真實證件，也沒有金鑰。

Google 即時 images.annotate 說明圖片在記憶體處理且不落磁碟；不要切成非同步批次。OpenAI 使用 store:false，但這不會消除預設最多 30 天濫用監控；需要零保留時必須事先核准 ZDR，且圖片安全審查有例外，不能承諾絕對零保留。

應用程式不寫入原圖到 D1/R2/KV，不寫入完整 OCR 文字到一般日誌。瀏覽器只以 File/Blob 暫存，移除列、重設或離開頁面後釋放；物件 URL 有清理。後端請求完成後無持久影像，因此不需要 R2 清除排程。原有手動「案件附件」上傳是獨立且永久保存的業務操作，不能把 OCR 原圖自動送入該路徑。

設定於 API Worker Secrets（或本機 apps/server/.dev.vars，已被 gitignore 排除）：

```dotenv
GOOGLE_VISION_API_KEY=<啟用 Vision API 且限制僅此 API 的服務端金鑰>
OPENAI_API_KEY=<專案專用服務端金鑰>
BULK_OCR_MODEL=gpt-5.4-2026-03-05
BULK_OCR_ENABLED=true
BULK_OCR_PRIVACY_APPROVED=true
```

沿用現有 BETTER_AUTH_SECRET 簽章，不更換正式密鑰。CORS_ORIGIN 需含前端精確來源，包含本機 http://localhost:3000。不要放在 NEXT_PUBLIC_*、前端 bundle、GitHub committed env 或聊天訊息。既有 Alchemy 入口未完整對齊正式資源，本輪不增改正式部署機制；日後部署前需明確傳入以上服務端 bindings。

## 成本與速度

查核 2026-10-25：Google Document Text Detection 標準級前 1000 單位/月免費，之後至 500 萬為 US$1.50/1000，即約 $0.0015/圖。OpenAI GPT-5.4 一般輸入 $2.50/百萬 tokens、輸出 $15/百萬 tokens，影像 token 依尺寸與 detail 計算，不能固定用每張字數估計。

範例假設單圖總輸入 2000 tokens、輸出 400 tokens：Google + OpenAI 約 $0.0125/張；若輸出達本實作上限 1600 tokens，在相同輸入假設下約 $0.0305/張。這只是規劃算例，不是實測、報價或上限；大圖、重新執行、供應商變價、Workers/D1 費用另計。請在各供應商設定帳務預算/配額並用實際 token usage 核算。

沒有實測延遲，不提供保證秒數。一批 20 張順序辨識可能需數分鐘；手動重試會再計費。

## 本機操作與測試

1. 專案需要 Node 24、pnpm 10.24.0；既有依賴已安裝。
2. `pnpm dev:local` 使用本機 D1/KV/R2 與模擬業務資料；開 http://localhost:3000/cases/bulk-create，沿用本機已佈建帳號。
3. 未配置供應商時可檢查選圖、同意、失敗處理；OCR 會安全回覆未啟用。不得把「按鈕可用」當作辨識成功。
4. 需實際辨識時，在本機 .dev.vars 配置經核准的設定並重新啟動，只先用合成/已授權去識別資料。dev:local 清除 process.env 的 OPENAI_*，請使用 Wrangler 的 .dev.vars，不改成連線正式資料庫。
5. 選新案件/歷史案件→同意傳送→選圖/拖曳→逐列檢查原圖與證據→修改缺字/縣市→逐列確認或全部確認→預覽並驗證→確認批量建立。失敗圖片可重試或移除，其他列保留。
6. `pnpm test:ocr`：獨立規則與審核憑證測試（不連雲端）。`pnpm typecheck`：各 workspace；`pnpm test`：既有 Cloudflare integration suite。

已完成：API、server、web 型別檢查通過；15 項獨立規則/憑證測試通過；前端 client/SSR 本機 build 通過；14 個程式變更檔 Biome 檢查與 git diff --check 通過。嘗試全套 Cloudflare 測試時，既有 pool 啟動失敗：No such module cloudflare:test-internal，測試未開始，故不能宣稱舊功能或新增 D1 整合已通過。尚無實際供應商、真實樣本與完整瀏覽器端到端驗收。

## 真實樣本準確率驗收

由授權人員在受控本機保留圖片，兩人獨立標記三欄真值再解決分歧；未知/不可讀使用空字串。每張圖獨立 sampleId、版面/模糊/手寫/地址衝突等類別。建立盲測集及開發集，避免只測熟悉樣本。不要把真實證件或含個資的 JSONL 提交 GitHub。

本機 JSONL 每行格式（虛構示例）：

```json
{"sampleId":"synthetic-001","humanLabeled":true,"truth":{"code":"菲菲","customerName":"莊佩璇","region":"彰化縣"},"prediction":{"code":"菲菲","customerName":"莊佩璇","region":"彰化縣"},"requiresReview":true,"autoAccepted":false}
```

`node scripts/evaluate-bulk-ocr.mjs <本機標準答案及預測.jsonl>` 僅輸出彙總：各欄建議正確率、召回率、棄答比例、人工確認率、錯誤自動接受率。所有結果都須人工確認，人工確認率為 100%；無自動接受樣本時錯誤自動接受率是 N/A（null），不是以 0% 宣稱模型安全。

99.5% 應針對被提出的值計算 precision，同時報告覆蓋率及各類樣本分層結果；不能用全部留白取得高正確率。人工修改後的結果不可當作模型預測。即使 600 個獨立非空建議全部正確，也只接近單側 95% 下界 99.5%；需足夠且具代表性的盲測與統計區間，不以少量 demo 宣稱達標。評分工具永遠不自動認證 99.5%。

## 官方參考

- https://docs.cloud.google.com/vision/docs/ocr
- https://docs.cloud.google.com/vision/docs/languages
- https://docs.cloud.google.com/vision/docs/data-usage
- https://cloud.google.com/vision/pricing
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/your-data
- https://developers.openai.com/api/docs/models/gpt-5.4
- https://developers.cloudflare.com/workers/platform/limits/

