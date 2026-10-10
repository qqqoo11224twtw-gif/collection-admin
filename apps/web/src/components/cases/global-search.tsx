import { Input } from '@saasflare-dev/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';
import { useCasePermissions } from './management-hooks';

export function GlobalCaseSearch() {
  const { data: session } = useSession();
  const permissions = useCasePermissions();
  return session && permissions.can('case.search') ? (
    <SearchBar key={session.user.id} userId={session.user.id} />
  ) : null;
}
function SearchBar({ userId }: { userId: string }) {
  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    const timeout = setTimeout(() => setQuery(value.trim()), 250);
    return () => clearTimeout(timeout);
  }, [value]);
  useEffect(() => {
    if (location.pathname) setOpen(false);
  }, [location.pathname]);
  const options = orpc.cases.list.queryOptions({
    input: { query, page: 1, pageSize: 20 },
  });
  const results = useQuery({
    ...options,
    queryKey: [userId, ...options.queryKey],
    enabled: open && !!query,
    retry: false,
  });
  return (
    <header className="border-b border-border bg-card px-4 py-3">
      <div className="mx-auto flex max-w-6xl items-center gap-4">
        <Link
          to="/cases"
          search={{ query: '', page: 1 }}
          className="text-sm font-semibold shrink-0"
        >
          案件管理
        </Link>
        {/* Search is global across accessible cases, regardless of the current page. */}
        <search
          className="relative ml-auto min-w-0 flex-1 max-w-lg"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setOpen(false);
          }}
        >
          <Search
            aria-hidden
            className="absolute left-3 top-2.5 size-4 text-muted-foreground"
          />
          <Input
            aria-label="全域案件搜尋"
            placeholder="搜尋客戶、代號、案件編號或地址"
            maxLength={120}
            className="pl-9 pr-9"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          {value && (
            <button
              type="button"
              aria-label="清除搜尋"
              className="absolute right-3 top-2.5 text-muted-foreground"
              onClick={() => {
                setValue('');
                setQuery('');
                setOpen(false);
              }}
            >
              <X className="size-4" />
            </button>
          )}
          {open && value.trim() && (
            <section
              aria-label="搜尋結果"
              className="absolute top-full z-50 mt-2 w-full rounded-xl bg-popover p-2 shadow-lg ring-1 ring-foreground/10"
            >
              <p className="px-3 py-2 text-sm text-muted-foreground">
                姓名、代號與案件編號：前綴搜尋 · 地址：包含搜尋
              </p>
              {query !== value.trim() || results.isPending ? (
                <output className="block p-3 text-sm">搜尋中…</output>
              ) : results.isError ? (
                <p role="alert" className="p-3 text-sm text-destructive">
                  搜尋失敗，請重試。
                </p>
              ) : results.data?.items.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  找不到符合條件的案件。
                </p>
              ) : (
                results.data?.items.slice(0, 6).map((record) => (
                  <Link
                    key={record.id}
                    to="/cases/$caseId"
                    params={{ caseId: record.id }}
                    className="flex items-center justify-between gap-3 rounded-lg px-3 py-3 hover:bg-muted focus-visible:bg-muted"
                    onClick={() => setOpen(false)}
                  >
                    <span className="text-sm font-medium">
                      {record.customerName}
                      <span className="block font-normal text-muted-foreground">
                        {record.code}
                      </span>
                    </span>
                    <span className="text-sm font-mono">{record.caseNo}</span>
                  </Link>
                ))
              )}
              {results.data && results.data.total > 6 && (
                <Link
                  to="/cases"
                  search={{ query, page: 1 }}
                  className="block rounded-lg p-3 text-sm font-medium hover:bg-muted"
                  onClick={() => setOpen(false)}
                >
                  查看全部 {results.data.total} 筆結果
                </Link>
              )}
            </section>
          )}
        </search>
      </div>
    </header>
  );
}
