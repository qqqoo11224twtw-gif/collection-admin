import { Button } from '@saasflare-dev/ui/components/button';
import { useState } from 'react';
import { CollectorFinancePanel } from './collector-finance-panel';
import { CollectorRateSettings } from './collector-rate-settings';
import { useCasePermissions } from './management-hooks';

export function FinanceWorkspace() {
  const permissions = useCasePermissions();
  const [settings, setSettings] = useState(false);
  if (!permissions.can('settlement.view')) return <p>無操作權限</p>;
  return (
    <div className="space-y-5">
      <nav aria-label="財務分頁" className="flex flex-wrap gap-2">
        <Button
          variant={settings ? 'outline' : 'default'}
          onClick={() => setSettings(false)}
        >
          外收帳務
        </Button>
        {permissions.can('finance.return_rate.manage') && (
          <Button
            variant={settings ? 'default' : 'outline'}
            onClick={() => setSettings(true)}
          >
            財務設定
          </Button>
        )}
      </nav>
      {settings ? <CollectorRateSettings /> : <CollectorFinancePanel />}
    </div>
  );
}
