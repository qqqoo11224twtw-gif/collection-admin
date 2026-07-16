import { cn } from '@saasflare-dev/ui/lib/utils';
import { useState } from 'react';

const SERVER_URL = import.meta.env.NEXT_PUBLIC_SERVER_URL;

/**
 * Copy-paste usage snippets for the external API, one per common client.
 * `sfapp_…` is a placeholder on purpose — the real key must come from the
 * caller's env / secret manager, never from source code.
 */
const SNIPPETS: Array<{ id: string; label: string; code: string }> = [
  {
    id: 'curl',
    label: 'cURL',
    code: `curl ${SERVER_URL}/api/v1/whoami \\
  -H 'Authorization: Bearer sfapp_…'

# → {"keyId":"…","userId":"…"}`,
  },
  {
    id: 'node',
    label: 'Node.js',
    code: `// Node 18+ (built-in fetch). Key comes from the environment.
const res = await fetch('${SERVER_URL}/api/v1/whoami', {
  headers: { Authorization: \`Bearer \${process.env.API_KEY}\` },
});
if (!res.ok) throw new Error(\`request failed (\${res.status})\`);
console.log(await res.json()); // { keyId, userId }`,
  },
  {
    id: 'python',
    label: 'Python',
    code: `import os
import requests

res = requests.get(
    "${SERVER_URL}/api/v1/whoami",
    headers={"Authorization": f"Bearer {os.environ['API_KEY']}"},
)
res.raise_for_status()
print(res.json())  # {'keyId': '…', 'userId': '…'}`,
  },
  {
    id: 'go',
    label: 'Go',
    code: `req, _ := http.NewRequest("GET", "${SERVER_URL}/api/v1/whoami", nil)
req.Header.Set("Authorization", "Bearer "+os.Getenv("API_KEY"))

res, err := http.DefaultClient.Do(req)
if err != nil || res.StatusCode != 200 {
    log.Fatal("request failed")
}
// body: { "keyId": "…", "userId": "…" }`,
  },
];

/** Language-tabbed usage examples shown under the key table on the API keys example page. */
export function ApiUsageExamples() {
  const [active, setActive] = useState(SNIPPETS[0].id);
  const snippet = SNIPPETS.find((s) => s.id === active) ?? SNIPPETS[0];

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">Use your key</h3>
        <p className="text-xs text-muted-foreground">
          Send it as a Bearer token. <code>/api/v1/whoami</code> is the demo
          endpoint — products replace it with their real API and keep the auth.
          Store the key in your caller's secret manager, never in source code.
        </p>
      </div>

      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="Client language"
      >
        {SNIPPETS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === s.id}
            onClick={() => setActive(s.id)}
            className={cn(
              'text-xs font-medium px-3 py-1.5 rounded-full border transition-colors',
              active === s.id
                ? 'bg-foreground text-background border-transparent'
                : 'bg-card text-muted-foreground border-border hover:bg-muted',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed text-foreground">
        {snippet.code}
      </pre>
    </section>
  );
}
