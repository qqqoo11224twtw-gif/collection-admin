# CSS Architecture

How styling is wired in this repo: file responsibilities, token placement rules,
and the traps that have already bitten us. Assumes working knowledge of Tailwind
v4 — this documents what is **specific to this project**.

Scope is mechanics: which file owns what, and which constraints are load-bearing.
It does not prescribe visual values — those are the design system's concern.

---

## Where to change what

| Goal | Location |
|---|---|
| Type scale, line height, spacing, radius, fonts | `packages/ui/src/styles/globals.css`, **trailing `:root` block** |
| A brand-new utility class (e.g. `bg-success`) | Same file, but also needs an `@theme` block — see §4 |
| Add a component | `pnpm --filter @saasflare-dev/ui exec shadcn add <name>` |
| App-only styling (webfont imports, scrollbar) | `apps/web/src/styles/globals.css` |
| **Never hand-edit** | `packages/ui/src/components/*.tsx` |

Only two stylesheets are ours; everything else arrives via `@import` from
`node_modules`.

---

## 1. File map

```
packages/ui/src/styles/globals.css   entry point + design system
apps/web/src/styles/globals.css      product layer (webfonts, scrollbar, app quirks)
```

`packages/ui/src/styles/globals.css` layout — **order is load-bearing**:

```css
@import "tailwindcss";
@source "../**/*.{ts,tsx}";
@import "tw-animate-css";
@import "shadcn/tailwind.css";   /* data-open / data-checked variants radix-vega needs */

@custom-variant dark (...);      /* ┐                                        */
@theme inline { ... }            /* │ shadcn CLI territory.                  */
:root { --radius; colors }       /* │ Maintained by `shadcn add`.            */
.dark { ... }                    /* │ `.dark` values are UNMAINTAINED — §5.  */
@layer base { ... }              /* ┘                                        */

:root { --font-sans; --font-mono }  /* ours — MUST stay last, see §3 */
```

### `@source`

Rarely needed. Tailwind v4 auto-detects sources by walking up to the git root,
which already covers `apps/` and `packages/`.

Two `@source` lines were removed in `153b1a6`: they read `../../../apps/**`,
which resolves to `packages/apps/` (one level short, nonexistent). Recompiling
after deletion produced a byte-identical stylesheet (118953 bytes) — they had
never contributed anything.

---

## 2. How stylesheets reach the browser

```tsx
// apps/web/src/routes/__root.tsx
import uiGlobalsCss from '@saasflare-dev/ui/styles/globals.css?url';
import globalsCss   from '~/styles/globals.css?url';

links: [
  { rel: 'stylesheet', href: uiGlobalsCss },   // first
  { rel: 'stylesheet', href: globalsCss },     // second — can override the first
]
```

`?url` yields the compiled asset URL rather than the file contents, so these
become two `<link>` tags. Link order determines cascade order.

Path resolution needs both of these — neither alone is sufficient:

| Where | Role |
|---|---|
| `apps/web/tsconfig.json` → `paths: { "@saasflare-dev/ui/*": ["../../packages/ui/src/*"] }` | TypeScript resolution |
| `apps/web/vite.config.ts` → `resolve: { tsconfigPaths: true }` | Vite reads the same paths at build time |

`packages/ui/package.json` has **no `exports` field**, so standard package
resolution does not apply. shadcn's monorepo guide recommends adding one.
Equivalent in behaviour, more conventional. **Open TODO, not urgent.**

---

## 3. Why tokens go at the end of `globals.css`

### Utilities dereference variables

Compiled output:

```css
.text-sm    { font-size: var(--text-sm); line-height: var(--tw-leading, var(--text-sm--line-height)); }
.rounded-lg { border-radius: var(--radius); }
.font-sans  { font-family: var(--font-sans); }
```

Values are never inlined. Redefining a variable therefore restyles every use of
the corresponding utility across all apps — this is what lets the design system
retune the UI without touching component source.

### Position is what makes overriding possible

CSS variables follow the cascade: for equal specificity, the **last**
declaration wins. `@import` must precede all rules, so an imported file always
lands *before* `globals.css`'s own `:root` and can never override what shadcn
declares there.

Measured both ways:

| Approach | Overriding `--radius` |
|---|---|
| Separate file pulled in by a top-of-file `@import` | fails — stays `0.625rem` |
| Trailing `:root` in `globals.css` | works |

A `tokens.css` existed briefly and was deleted in `7dcc2ca` for this reason.

### Editing a CLI-managed file is safe here

shadcn's `update-css.ts` merges in place via PostCSS rather than rewriting:
existing content is preserved, new content is merged. Corroborated locally —
`shadcn add` of 25 components (including `sidebar`, which carries its own
tokens) left `globals.css` byte-identical, and the hand-written
`button:not([disabled]) { cursor: pointer }` at its end has survived every
shadcn run so far.

**Invariant: our `:root` block stays last in the file.**

---

## 4. `:root` vs `@theme`

| Intent | Use | Reason |
|---|---|---|
| Override an existing value (`--font-sans`, `--text-sm`, `--radius`, colors) | trailing `:root` | The utility already exists and dereferences the variable |
| Introduce a new utility class (`bg-success`) | `@theme` as well | Tailwind must know the class exists at build time |

Declaring `--color-success` in `:root` alone will **not** generate `bg-success`.

Keep the block to variable assignments. If a selector-based override becomes
unavoidable (e.g. `[data-slot="table-cell"] { ... }` for density), put it in a
separate `overrides.css` and `@import` it — selector overrides compete on
specificity and are not subject to the ordering constraint above. Its line count
is then the honest answer to "how much are we overriding"; ideally the file does
not exist.

---

## 5. Known traps

### Class names must appear literally in source

Tailwind scans source files as **plain text** at build time and never parses
them as code, so a class assembled from parts does not exist:

> Since Tailwind scans your source files as plain text, it has no way of
> understanding string concatenation or interpolation.
> — [Detecting classes in source files](https://tailwindcss.com/docs/detecting-classes-in-source-files)

```tsx
className={`text-${step}`}          // ✗ produces no CSS at all
className={`bg-${color}-600`}       // ✗ same
```

Map to complete class names instead:

```tsx
const STEPS = [ { key: 'sm', cls: 'text-sm' }, … ];   // ✓
const STATUS = { succeeded: 'bg-success/10 text-success', … };
```

No `@source` setting changes this. `@source` picks which *files* get scanned;
a string that only exists at runtime is in no file. This has bitten twice here:
once rendering a type-scale table from `text-${step}`, once "verifying" tokens
in a browser probe.

**Corollary — how to check whether a utility exists.** Building an element at
runtime and reading `getComputedStyle` cannot tell you: that measures whether
a rule is in the stylesheet, and the rule's existence was decided at build time
from text the probe never contributed to. Check the compiled output, or use the
class once in real source:

```bash
curl -s "http://localhost:3000/@fs/$PWD/packages/ui/src/styles/globals.css" \
  | grep -c '\.bg-success'
```

A utility legitimately reports 0 when nothing in the codebase uses it yet —
generation is on demand, so absence there is not a broken token.

### Fonts are the only property with two competing paths

Everything else (size, radius, color) reaches elements through utilities only.
Fonts additionally inherit from `body`, so two independent mechanisms can
disagree:

```
body { font-family: ... }        inheritance
.font-sans { ... }               utility, reads var(--font-sans)
```

Unlayered rules outrank **all** layered ones, and that comparison happens before
specificity — so a bare `body {}` rule beats `.font-sans` inside
`@layer utilities`, despite the class selector being more specific.

This produced two outcomes before `f45cf16`:

- **sans**: accidentally correct — the bare `body` rule won, so the CJK stack applied
- **mono**: silently broken — `.font-mono` had no `body` fallback and `--font-mono`
  was never defined, so all four `font-mono` sites rendered in the system
  monospace stack even though Geist Mono was installed and imported

Both stacks now live in the trailing `:root`, and `body` reads
`var(--font-sans)`, so the two paths cannot diverge again.

### `.dark` values are stale by decision

The `.dark` block holds shadcn factory values and is deliberately not maintained
alongside `:root`. Dark mode is wired (`next-themes`) but pinned off via
`<ThemeProvider forcedTheme="light">` in `__root.tsx`. Enabling it requires
retuning those values first.

### CJK families in the font stack are intentional

`"PingFang SC"`, `"Hiragino Sans GB"` etc. sit between Geist and the system
stack so mixed Chinese/English text renders consistently. Systems lacking them
fall through at no cost — do not "simplify" them away.

---

## 6. Deviations from the shadcn standard

| Aspect | Here | shadcn guide | |
|---|---|---|---|
| Directory layout | `packages/ui/src/{components,hooks,lib,styles}` | same | ok |
| `globals.css` location | `packages/ui/src/styles/` | same | ok |
| Token customization | edited in place | same (CLI merges) | ok |
| Package resolution | tsconfig paths + Vite | `package.json` `exports` | TODO |

An alternative wiring is to chain the stylesheets — have the app's `globals.css`
`@import` the package one, yielding a single `<link>`. Cascade behaviour is
equivalent, since link order and import order both resolve the same way, and it
requires a relative path across package boundaries instead of the alias. The two
`<link>` tags are kept for that reason.

---

## See also

- [`ui-guidelines.md`](ui-guidelines.md) — component installation and import rules
- [`rules-tanstack.md`](rules-tanstack.md) — frontend framework conventions
