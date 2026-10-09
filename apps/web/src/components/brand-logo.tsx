import { HandCoins } from 'lucide-react';

export function BrandLogo() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <HandCoins className="size-7" aria-hidden="true" />
      </span>
      <span className="font-semibold tracking-tight">案件管理後台</span>
    </div>
  );
}
