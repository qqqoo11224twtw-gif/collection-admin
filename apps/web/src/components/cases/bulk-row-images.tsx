import { Button } from '@saasflare-dev/ui/components/button';
import { useEffect, useState } from 'react';

export type RowImage = {
  id: string;
  file: File;
  state: 'waiting' | 'uploading' | 'ready' | 'failed';
  mediaId?: string;
};
function ImagePreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`預覽 ${file.name}`}
    >
      <img
        src={url}
        alt={file.name}
        className="h-20 w-20 rounded-md object-cover"
      />
    </a>
  );
}
export function BulkRowImages({
  row,
  images,
  disabled,
  onChange,
  onRetry,
  onRemove,
}: {
  row: number;
  images: RowImage[];
  disabled: boolean;
  onChange: (images: RowImage[]) => void;
  onRetry?: () => void;
  onRemove?: (image: RowImage) => void;
}) {
  return (
    <section className="space-y-2" aria-label={`第 ${row} 筆案件圖片`}>
      <label className="block text-sm">
        案件圖片
        <input
          aria-label={`第 ${row} 筆選擇圖片`}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={disabled}
          className="mt-2 block w-full min-w-0 text-sm"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (
              files.some(
                (file) =>
                  file.size === 0 ||
                  file.size > 5 * 1024 * 1024 ||
                  !['image/png', 'image/jpeg', 'image/webp'].includes(
                    file.type,
                  ),
              ) ||
              images.length + files.length > 100
            ) {
              e.target.setCustomValidity(
                '請選擇 PNG／JPEG／WebP，每張上限 5 MiB、每案最多 100 張。',
              );
              e.target.reportValidity();
              return;
            }
            e.target.setCustomValidity('');
            onChange([
              ...images,
              ...files.map((file) => ({
                id: crypto.randomUUID(),
                file,
                state: 'waiting' as const,
              })),
            ]);
            e.target.value = '';
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {images.length} 張 · 完成{' '}
        {images.filter((image) => image.state === 'ready').length} 張
        {images.length === 0 ? ' · 待補圖片' : ''}
      </p>
      <div className="flex flex-wrap gap-3">
        {images.map((image) => (
          <div key={image.id} className="w-24 space-y-1">
            <ImagePreview file={image.file} />
            <p className="break-all text-xs">{image.file.name}</p>
            <p className="text-xs">
              {
                {
                  waiting: '待上傳',
                  uploading: '上傳中',
                  ready: '已上傳',
                  failed: '上傳失敗',
                }[image.state]
              }
            </p>
            {(image.state !== 'ready' || onRemove) && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  image.state === 'ready'
                    ? onRemove?.(image)
                    : onChange(images.filter((item) => item.id !== image.id))
                }
              >
                移除
              </Button>
            )}
          </div>
        ))}
      </div>
      {images.some((image) => image.state === 'failed') && onRetry && (
        <Button disabled={disabled} variant="outline" onClick={onRetry}>
          重試失敗圖片
        </Button>
      )}
    </section>
  );
}
