import { Button } from '@saasflare-dev/ui/components/button';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@saasflare-dev/ui/components/dialog';
import { Input } from '@saasflare-dev/ui/components/input';
import { Label } from '@saasflare-dev/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { orpc } from '~/lib/orpc';
import { DialogContent } from './localized-dialog';
import { useCasePermissions } from './management-hooks';
import { CaseError, LoadingCases, timestamp } from './presentation';

export function TelegramBotPanel() {
  const permissions = useCasePermissions(),
    qc = useQueryClient();
  const canManage = permissions.can('telegram_bot.manage');
  const list = useQuery({
    ...orpc.telegram.bots.list.queryOptions(),
    enabled: canManage,
  });
  const [editing, setEditing] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    [disableId, setDisableId] = useState<string | null>(null);
  const done = () => {
    setEditing(null);
    setDisableId(null);
    setMessage('機器人設定已儲存。');
    void qc.invalidateQueries({ queryKey: orpc.telegram.key() });
  };
  // Never render provider errors, nor keep submitted tokens in React mutation state.
  const test = useMutation(
    orpc.telegram.bots.test.mutationOptions({
      onSuccess: () => {
        setMessage('已連線');
        void qc.invalidateQueries({ queryKey: orpc.telegram.bots.key() });
      },
      onError: () => setMessage('連線失敗，請確認 Bot 狀態與系統設定。'),
    }),
  );
  const update = useMutation(
    orpc.telegram.bots.update.mutationOptions({
      onSuccess: done,
      onError: () => setMessage('設定未儲存，請重新整理並確認路由影響。'),
    }),
  );
  const [busy, setBusy] = useState(false);
  if (!canManage) return null;
  const row = list.data?.find((record) => record.id === editing),
    disable = list.data?.find((record) => record.id === disableId);
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Bot className="size-5 text-primary" />
          Telegram 機器人
        </h2>
        <Button
          onClick={() => {
            setMessage('');
            setEditing('new');
          }}
        >
          綁定新機器人
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Token 加密保存，綁定後無法查看完整內容。既有環境憑證仍可供相容路由使用。
      </p>
      {message && <output className="block text-sm">{message}</output>}
      {list.isPending ? (
        <LoadingCases />
      ) : list.isError ? (
        <CaseError retry={() => void list.refetch()} />
      ) : !list.data.length ? (
        <p className="py-4 text-sm text-muted-foreground">
          目前沒有已綁定機器人。
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {list.data.map((bot) => (
            <article
              key={bot.id}
              className="space-y-3 rounded-xl border bg-background/40 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">
                  {bot.internalName || bot.displayName}
                </h3>
                <span
                  className={`text-xs ${bot.isActive ? 'text-success' : 'text-muted-foreground'}`}
                >
                  {bot.isActive ? '啟用' : '已停用'}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                @{bot.username} · Bot ID：{bot.telegramBotId}
              </p>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="size-4" />
                Token：已安全綁定
              </p>
              <p className="text-xs text-muted-foreground">
                最後驗證：{timestamp(bot.verifiedAt)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!bot.isActive || test.isPending}
                  onClick={() => test.mutate({ id: bot.id })}
                >
                  測試連線
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMessage('');
                    setEditing(bot.id);
                  }}
                >
                  重新綁定 Token
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() =>
                    bot.isActive
                      ? setDisableId(bot.id)
                      : update.mutate({
                          id: bot.id,
                          internalName: bot.internalName,
                          isActive: true,
                          expectedVersion: bot.version,
                        })
                  }
                >
                  {bot.isActive ? '停用' : '啟用'}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!busy && !open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{row ? '重新綁定 Token' : '綁定新機器人'}</DialogTitle>
            <DialogDescription>
              伺服器會驗證 Bot 身分後加密儲存。不同 Bot 請另外新增。
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                setBusy(true);
                try {
                  if (row)
                    await orpc.telegram.bots.rotate.call({
                      id: row.id,
                      token: String(data.get('token')),
                      expectedVersion: row.version,
                    });
                  else
                    await orpc.telegram.bots.bind.call({
                      token: String(data.get('token')),
                      internalName: String(data.get('name') ?? ''),
                    });
                  form.reset();
                  done();
                } catch {
                  form.reset();
                  setMessage('Telegram Bot Token 驗證失敗，或加密設定未完成。');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {!row && (
                <Label className="block space-y-2">
                  機器人名稱（選填）
                  <Input name="name" maxLength={120} />
                </Label>
              )}
              <Label className="block space-y-2">
                Telegram Bot Token
                <Input
                  name="token"
                  type="password"
                  autoComplete="off"
                  required
                />
              </Label>
              {message && (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  取消
                </Button>
                <Button disabled={busy}>
                  {busy ? '驗證中…' : '驗證並綁定'}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!disable}
        onOpenChange={(open) => {
          if (!open) setDisableId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>確認停用機器人</DialogTitle>
            <DialogDescription>
              此機器人目前仍有 {disable?.activeRoutes ?? 0} 條啟用中的 Telegram
              路由。停用後將停止新派件。
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={update.isPending}
            onClick={() =>
              disable &&
              update.mutate({
                id: disable.id,
                internalName: disable.internalName,
                isActive: false,
                confirmDisable: true,
                expectedVersion: disable.version,
              })
            }
          >
            確認停用
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
