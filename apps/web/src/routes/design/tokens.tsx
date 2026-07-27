import { createFileRoute } from '@tanstack/react-router';
import { CircleCheck, CircleX, Clock, Info } from 'lucide-react';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/design/tokens')({
  component: TokensPage,
});

/*
 * Candidate values for the semantic colors this project does not have yet.
 * Only --destructive exists today, which is why every non-error status in the
 * app currently renders as the same grey.
 *
 * Both sets are stock Tailwind steps rather than invented values, because
 * --destructive already *is* Tailwind red-600 — matching that step keeps the
 * whole set at one perceptual lightness. Values are inline here on purpose:
 * nothing is committed to a token until one set is chosen.
 */
const SEMANTIC_SETS = [
  {
    name: 'A · Primary hues',
    note: 'green / amber / blue at the 600 step — the same step --destructive already uses. Highest chroma, so statuses read strongly at badge size.',
    colors: {
      danger: 'oklch(0.577 0.245 27.325)',
      success: 'oklch(0.627 0.194 149.214)',
      warning: 'oklch(0.666 0.179 58.318)',
      info: 'oklch(0.546 0.245 262.881)',
    },
  },
  {
    name: 'B · Muted hues',
    note: 'emerald / yellow / sky at the same step. Lower chroma reads calmer in a table where several rows carry a status at once.',
    colors: {
      danger: 'oklch(0.577 0.245 27.325)',
      success: 'oklch(0.596 0.145 163.225)',
      warning: 'oklch(0.681 0.162 75.834)',
      info: 'oklch(0.588 0.158 241.966)',
    },
  },
] as const;

const SEMANTIC_ROLES = [
  { key: 'success', label: 'Succeeded', Icon: CircleCheck },
  { key: 'warning', label: 'Pending', Icon: Clock },
  { key: 'danger', label: 'Failed', Icon: CircleX },
  { key: 'info', label: 'Refunded', Icon: Info },
] as const;

function SemanticSet({ set }: { set: (typeof SEMANTIC_SETS)[number] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium tracking-tight">{set.name}</h3>
        <p className="text-sm text-muted-foreground">{set.note}</p>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
        {/* Soft badges — how a status column actually renders */}
        <div className="flex flex-wrap gap-2">
          {SEMANTIC_ROLES.map(({ key, label, Icon }) => {
            const c = set.colors[key];
            return (
              <span
                key={key}
                className="inline-flex h-5 items-center gap-1 rounded-4xl px-2 text-xs font-medium"
                style={{
                  color: c,
                  background: `color-mix(in oklch, ${c} 12%, transparent)`,
                }}
              >
                <Icon className="size-3" />
                {label}
              </span>
            );
          })}
        </div>

        {/* Solid — for the rare case a status needs to shout */}
        <div className="flex flex-wrap gap-2">
          {SEMANTIC_ROLES.map(({ key, label }) => (
            <span
              key={key}
              className="inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium text-white"
              style={{ background: set.colors[key] }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* On body text, which is where contrast against 14px matters */}
        <div className="flex flex-col gap-1">
          {SEMANTIC_ROLES.map(({ key, label }) => (
            <span
              key={key}
              className="text-sm"
              style={{ color: set.colors[key] }}
            >
              {label} — the charge could not be completed.
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

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
        title="Semantic colors — pick a set"
        note="Not yet committed to a token. Today only --destructive exists, which is why every non-error status in the app renders as the same grey. Both candidate sets use stock Tailwind steps at the same lightness as --destructive (which is itself Tailwind red-600), so the four statuses sit at one perceptual weight."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          {SEMANTIC_SETS.map((set) => (
            <SemanticSet key={set.name} set={set} />
          ))}
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
