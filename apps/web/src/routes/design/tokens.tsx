import { createFileRoute } from '@tanstack/react-router';
import { CircleCheck, CircleX, Clock, Info } from 'lucide-react';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/design/tokens')({
  component: TokensPage,
});

/*
 * Status roles, rendered from the real tokens rather than literal values, so
 * this section keeps reflecting whatever --success/--warning/--info hold.
 * Class names are spelled out because Tailwind scans source text statically.
 */
const SEMANTIC_ROLES = [
  {
    key: 'success',
    label: 'Succeeded',
    Icon: CircleCheck,
    soft: 'bg-success/10 text-success',
    solid: 'bg-success text-white',
    text: 'text-success',
    token: '--success',
    origin: 'emerald-600',
  },
  {
    key: 'warning',
    label: 'Pending',
    Icon: Clock,
    soft: 'bg-warning/10 text-warning',
    solid: 'bg-warning text-white',
    text: 'text-warning',
    token: '--warning',
    origin: 'yellow-600',
  },
  {
    key: 'danger',
    label: 'Failed',
    Icon: CircleX,
    soft: 'bg-destructive/10 text-destructive',
    solid: 'bg-destructive text-white',
    text: 'text-destructive',
    token: '--destructive',
    origin: 'red-600',
  },
  {
    key: 'info',
    label: 'Refunded',
    Icon: Info,
    soft: 'bg-info/10 text-info',
    solid: 'bg-info text-white',
    text: 'text-info',
    token: '--info',
    origin: 'sky-600',
  },
] as const;

/*
 * Class names are spelled out in full on purpose. Tailwind scans source text
 * statically, so a template literal like `text-${step}` produces no CSS at all
 * — the utility silently never exists and getComputedStyle would report the
 * inherited value instead of the token's.
 */
const TEXT_STEPS = [
  { key: 'xs', cls: 'text-xs' },
  { key: 'sm', cls: 'text-sm' },
  { key: 'base', cls: 'text-base' },
  { key: 'lg', cls: 'text-lg' },
  { key: 'xl', cls: 'text-xl' },
  { key: '2xl', cls: 'text-2xl' },
] as const;

const RADIUS_STEPS = [
  { key: 'sm', cls: 'rounded-sm' },
  { key: 'md', cls: 'rounded-md' },
  { key: 'lg', cls: 'rounded-lg' },
  { key: 'xl', cls: 'rounded-xl' },
] as const;

const SPACING_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

const COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'primary',
  'secondary',
  'muted',
  'muted-foreground',
  'accent',
  'destructive',
  'border',
  'input',
  'ring',
] as const;

interface Resolved {
  text: Record<string, { size: string; leading: string; ratio: string }>;
  radius: Record<string, string>;
  spacing: string;
}

/**
 * Values are read from the live document rather than hard-coded, so this page
 * keeps telling the truth after the tokens change. Reading happens in an effect
 * because getComputedStyle needs a real document — during SSR we render the
 * labels with empty values and fill them on hydration.
 */
function useResolvedTokens(): Resolved | null {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);

    const read = (cls: string, prop: keyof CSSStyleDeclaration) => {
      probe.className = cls;
      return String(getComputedStyle(probe)[prop]);
    };

    const text: Resolved['text'] = {};
    for (const { key, cls } of TEXT_STEPS) {
      const size = read(cls, 'fontSize');
      const leading = read(cls, 'lineHeight');
      const px = Number.parseFloat(size);
      const lh = Number.parseFloat(leading);
      text[key] = {
        size,
        leading,
        ratio:
          Number.isFinite(px) && Number.isFinite(lh) && px > 0
            ? (lh / px).toFixed(2)
            : '—',
      };
    }

    const radius: Resolved['radius'] = {};
    for (const { key, cls } of RADIUS_STEPS) {
      radius[key] = read(cls, 'borderTopLeftRadius');
    }

    const spacing = read('p-1', 'paddingTop');

    probe.remove();
    setResolved({ text, radius, spacing });
  }, []);

  return resolved;
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground max-w-2xl">{note}</p>
      </div>
      {children}
    </section>
  );
}

function TokensPage() {
  const resolved = useResolvedTokens();

  return (
    <div className="flex flex-col gap-12">
      <Section
        title="Type scale"
        note="Read live from the document. The ratio column is line-height ÷ font-size — the number that decides whether dense Chinese text has room to breathe. Adjacent steps should differ by at least 1.25x, otherwise the hierarchy reads as noise rather than structure."
      >
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {TEXT_STEPS.map(({ key, cls }) => (
            <div
              key={key}
              className="flex items-baseline gap-4 px-4 py-3 flex-wrap"
            >
              <code className="text-xs text-muted-foreground w-20 shrink-0">
                {cls}
              </code>
              <span className="text-xs text-muted-foreground w-40 shrink-0 tabular-nums font-mono">
                {resolved
                  ? `${resolved.text[key].size} / ${resolved.text[key].leading} = ${resolved.text[key].ratio}`
                  : '…'}
              </span>
              <span className={cls}>The quick brown fox 敏捷的棕色狐狸</span>
              {key === 'xs' && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  metadata only
                </span>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Spacing"
        note={`Every p-*, m-*, gap-* and fixed size derives from a single base unit (--spacing, currently ${resolved?.spacing ?? '…'}). Changing it rescales the entire UI at once, which is a blunt instrument — prefer fixing proportions in the type scale first.`}
      >
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
          {SPACING_STEPS.map((n) => (
            <div key={n} className="flex items-center gap-3">
              <code className="text-xs text-muted-foreground w-16 shrink-0">
                {n}
              </code>
              <div
                className="h-3 bg-foreground/80 rounded-xs"
                style={{ width: `calc(var(--spacing) * ${n})` }}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Radius"
        note="All four steps derive from --radius. Components pick a step; the product picks the base."
      >
        <div className="flex flex-wrap gap-3">
          {RADIUS_STEPS.map(({ key, cls }) => (
            <div key={key} className="flex flex-col items-center gap-1.5">
              <div className={`size-16 border border-border bg-card ${cls}`} />
              <code className="text-xs text-muted-foreground">{cls}</code>
              <span className="text-xs text-muted-foreground font-mono tabular-nums">
                {resolved?.radius[key] ?? '…'}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Status colors"
        note="Stock Tailwind steps, not invented values: --destructive is exactly red-600, so emerald / yellow / sky at the same step keep all four statuses at one perceptual lightness. Use the soft form for anything repeating down a column — several solid badges in a table fight each other. Solid is for a single status that has to be unmissable."
      >
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Token</th>
                <th className="px-4 py-2.5 text-left font-medium">Soft</th>
                <th className="px-4 py-2.5 text-left font-medium">Solid</th>
                <th className="px-4 py-2.5 text-left font-medium">
                  As body text
                </th>
              </tr>
            </thead>
            <tbody>
              {SEMANTIC_ROLES.map((r) => (
                <tr
                  key={r.key}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2.5 align-middle whitespace-nowrap">
                    <code className="text-xs">{r.token}</code>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.origin}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 align-middle">
                    <span
                      className={`inline-flex h-5 items-center gap-1 rounded-4xl px-2 text-xs font-medium ${r.soft}`}
                    >
                      <r.Icon className="size-3" />
                      {r.label}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 align-middle">
                    <span
                      className={`inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium ${r.solid}`}
                    >
                      {r.label}
                    </span>
                  </td>
                  <td className={`px-4 py-2.5 align-middle ${r.text}`}>
                    The charge could not be completed.
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Color"
        note="The tokens that exist today. Semantic names only — reach for these before a palette class, so one meaning keeps one value."
      >
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {COLOR_TOKENS.map((token) => (
            <div
              key={token}
              className="flex items-center gap-2.5 rounded-md border border-border bg-card p-2"
            >
              <div
                className="size-8 shrink-0 rounded border border-border"
                style={{ background: `var(--${token})` }}
              />
              <code className="text-xs text-muted-foreground truncate">
                --{token}
              </code>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
