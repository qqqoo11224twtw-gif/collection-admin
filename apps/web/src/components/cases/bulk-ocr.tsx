import type { BulkOcrResult } from '@saasflare-dev/api/bulk-ocr-contract';
import { Button } from '@saasflare-dev/ui/components/button';
import { useEffect, useState } from 'react';
export type OcrDraft = {
  id: string;
  file: File;
  state: 'processing' | 'ready' | 'failed';
  progress: number;
  result?: BulkOcrResult;
  error?: string;
};
export function BulkOcrInput({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [consent, setConsent] = useState(false);
  return (
    <section
      className="space-y-3 rounded-xl border bg-card p-4"
      aria-label="AI 圖片辨識建檔"
    >
      <h2 className="font-medium">AI 圖片辨識建檔</h2>
      <p className="text-sm text-muted-foreground">
        一張圖片一筆資料，最多 20
        筆。辨識只提取代號、姓名、地區；所有結果都必須核對原圖。原圖不會自動保存為案件附件。
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={consent}
          disabled={disabled}
          onChange={(e) => setConsent(e.target.checked)}
        />
        我有權處理這些圖片，同意傳送至 Google Cloud Vision 與 OpenAI。OpenAI
        預設濫用監控可能保留資料最多 30 天；管理者須事先確認適用政策。
      </label>
      <section
        aria-label="拖曳圖片上傳區"
        className="rounded-lg border border-dashed p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled && consent) onFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <label className="space-y-2 block text-sm">
          選取或拖曳 JPG、PNG、WEBP 圖片
          <input
            aria-label="選取 OCR 圖片"
            className="block w-full"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={disabled || !consent}
            onChange={(e) => {
              onFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </label>
      </section>
    </section>
  );
}
export async function recognizeFile(
  draft: OcrDraft,
  progress: (value: number) => void,
): Promise<BulkOcrResult> {
  const file = draft.file;
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw Error('僅支援 JPG、PNG、WEBP，每張最多 5 MB。');
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  let prepared: Blob;
  try {
    if (
      bitmap.width * bitmap.height > 40000000 ||
      Math.min(bitmap.width, bitmap.height) < 160
    )
      throw Error('圖片尺寸不足或過大，請重新拍攝清楚原圖。');
    // Decode EXIF orientation and strip metadata; never sharpen or invent strokes.
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('無法讀取圖片。');
    ctx.drawImage(bitmap, 0, 0);
    prepared = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(Error('無法處理圖片。'))),
        'image/png',
      ),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (prepared.size > 5 * 1024 * 1024)
      throw Error('無損處理後超過 5 MB，請拆分拼貼或提供較小原圖。');
  } finally {
    bitmap.close();
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/cases/bulk-ocr`,
    );
    xhr.withCredentials = true;
    xhr.timeout = 90000;
    xhr.setRequestHeader('Content-Type', 'image/png');
    xhr.setRequestHeader('X-OCR-Consent', 'google-openai-v1');
    xhr.setRequestHeader('X-Image-Id', draft.id);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(Error('連線失敗，請重試。'));
    xhr.ontimeout = () => reject(Error('辨識逾時，請重試。'));
    xhr.onabort = () => reject(Error('辨識已取消。'));
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status !== 200)
          throw Error(data.message ?? '辨識失敗，請重試。');
        if (data.imageId !== draft.id) throw Error('圖片與辨識結果不一致。');
        resolve(data as BulkOcrResult);
      } catch (error) {
        reject(error);
      }
    };
    xhr.send(prepared);
  });
}
export function OcrEvidence({
  draft,
  confirmed,
  disabled,
  onConfirm,
  onRetry,
}: {
  draft: OcrDraft;
  confirmed: boolean;
  disabled: boolean;
  onConfirm: (checked: boolean) => void;
  onRetry: () => void;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(draft.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [draft.file]);
  return (
    <section
      className="space-y-2 rounded-lg border p-3"
      aria-label="圖片辨識審核"
    >
      <p className="text-sm">
        {draft.state === 'processing'
          ? `上傳 ${draft.progress}%${draft.progress === 100 ? '，雙引擎辨識中…' : ''}`
          : draft.state === 'failed'
            ? draft.error
            : confirmed
              ? '已人工確認'
              : '待人工確認'}
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          查看原始圖片及文字證據
        </summary>
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            <img
              src={url}
              alt="此列待核對原圖"
              className="max-h-96 w-full object-contain"
            />
          </a>
        )}
        {draft.result && (
          <dl className="space-y-2 text-sm">
            {(['code', 'customerName', 'region'] as const).map((key) => {
              const field = draft.result?.fields[key];
              return (
                <div key={key}>
                  <dt>
                    {
                      { code: '代號', customerName: '姓名', region: '地區' }[
                        key
                      ]
                    }
                  </dt>
                  <dd>
                    原文：{field?.evidence || '無可靠證據'} · {field?.reason}
                  </dd>
                  {field?.area?.length ? (
                    <dd>
                      原圖文字區域（像素）：
                      {field.area.map((p) => `${p.x},${p.y}`).join(' / ')}
                    </dd>
                  ) : null}
                </div>
              );
            })}
          </dl>
        )}
      </details>
      {draft.state !== 'processing' && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={onRetry}
        >
          重新辨識此圖片
        </Button>
      )}
      <label className="flex gap-2 items-start text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || draft.state !== 'ready'}
          onChange={(e) => onConfirm(e.target.checked)}
        />
        我已核對此圖片，並確認代號、姓名、地區；無法辨識的欄位已人工補正。
      </label>
    </section>
  );
}
