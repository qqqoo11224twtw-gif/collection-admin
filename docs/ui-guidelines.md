# UI Guidelines

> **Scope: application UI.** Dashboards, settings, tables, forms — surfaces
> people return to and work in, where the goals are density, scannability and
> muscle memory across screens.
>
> **These rules do not apply to marketing pages.** A landing page has to
> convince a stranger in one visit: it wants a much wider type range (well past
> `text-2xl`), generous whitespace, and the freedom to look different on every
> page. Several rules below — retiring `text-xs`, capping the scale at four
> steps, preferring density — are actively wrong there.
>
> If a fork of this template grows a marketing site, give it its own typography
> and spacing rules rather than stretching these. The two surfaces share the
> brand (font family, brand color, logo) and nothing else.

## `@saasflare-dev/ui` Package Rules

- Install shadcn components with: `pnpm dlx shadcn@latest add <component> -c packages/ui` (run from root folder)
  - `shadcn` is also a dependency of `packages/ui`, so
    `pnpm --filter @saasflare-dev/ui exec shadcn add <component>` runs the exact
    version in the lockfile instead of whatever `@latest` resolves to. Prefer it
    when you want reproducibility.
- Note: use `shadcn@latest`, not `shadcn-ui@latest`
- Never hand-edit `packages/ui/src/components/*` — the CLI rewrites those files
  and silently drops your changes. Restyle through tokens instead; see
  [css-architecture.md](css-architecture.md).
  - Sole current exception: `sonner.tsx` re-exports `toast`, which upstream does
    not. Reapply it after re-pulling that component.

### Imports

```ts
// Correct
import { Button } from '@saasflare-dev/ui/components/button'

// Incorrect
import { Button } from '@saasflare-dev/ui/button'
```

The `tsconfig.json` path mapping `@saasflare-dev/ui/*` points to `packages/ui/src/*`.

### Adding a New Component

1. Check if it exists in `@saasflare-dev/ui`
2. If not, install it: `pnpm dlx shadcn@latest add <component> -c packages/ui`
3. Import and use it from `@saasflare-dev/ui`

### Component Specific Rules

- **Dialog Width**: `DialogContent` has a default `sm:max-w-md` class. To set wider (e.g., `max-w-4xl`), you MUST add the `sm:` prefix: `sm:max-w-4xl` — without it the default wins at `sm` and up.

## Styling

- Only use Tailwind CSS V4. No CSS inline styles.
- Follow mobile-first responsive design principles.
- The `cn` utility must be imported from `@saasflare-dev/ui/lib/utils`. Do not create a local `lib/utils.ts`.
- Icons: only use `lucide-react`, no SVG allowed.

## Design Principles (Refactoring UI)

### Spacing and Sizing

- Use Tailwind's spacing scale (base unit `0.25rem` / `4px`). Avoid arbitrary values.
- Use empty space (padding/margins) to group and separate elements, not borders.

### Color

- Use the semantic tokens (`text-foreground`, `text-muted-foreground`, `bg-card`,
  `border-border`, `bg-destructive`…), never a raw palette class such as
  `text-slate-800` or `text-red-600`. The tokens are theme-aware; raw classes are not.
- Use the primary color for primary actions only.

### Typography

Tailwind's scale is a palette to pick from, not a ladder to climb one rung at a
time. Picking adjacent steps (`text-xs` → `text-sm` → `text-base`) gives ratios
of 1.17 and 1.14, which reads as noise rather than hierarchy. Pick these:

| Role | Class | Size |
|---|---|---|
| Page title | `text-2xl` | 24px |
| Metric / headline number | `text-2xl` | 24px |
| Section heading — only when needed, see below | `text-lg` | 18px |
| Everything else: body, table cells, labels, form text | `text-sm` | 14px |

- **Do not use `text-xs`.** Secondary text stays at `text-sm` and recedes with
  `text-muted-foreground` instead of shrinking. 12px is the first step to break
  in dense CJK text, and shrinking is a weaker signal than contrast anyway.
  (Badges are the one place it may still earn its keep.)
- **Never use `text-sm` + caps as a section heading.** That puts the label at
  the same size as the content it labels, so size contributes nothing and the
  hierarchy rests entirely on letter-spacing tricks.
- Stick to a few font weights (`font-normal`, `font-medium`, `font-semibold`).
- Use `tabular-nums` on any column of figures so digits line up vertically.

#### Whether a section needs a heading

**Drop the heading when the content says what it is; keep it when a reader
could be unsure what they are looking at.**

A payments table on a page titled "Payments" is self-evident — a "Recent
activity" label above it is noise, and whitespace groups it fine. Six
same-shaped blocks on a settings page are not self-evident; without labels
people lose their place while scrolling.

This mirrors shadcn's own `dashboard-01`, which ships no section headings at
all: its three blocks (cards, chart, table) are visually distinct enough that
whitespace alone carries the grouping. Its entire type census is `text-sm`,
`text-2xl`/`text-3xl` for metrics, and zero `text-xs`.

Compare both arrangements live at `/design/scale`.

### Visual Hierarchy and Depth

- Use subtle shadows (`shadow-xs`, `shadow-sm`) for elevation.
- Prefer whitespace and background (`bg-card`, `bg-muted`) over borders for
  grouping. When a border is needed use `border-border`, never a palette class.
- Note that the current shadcn style separates surfaces with `ring-1
  ring-foreground/10` rather than a border — match the surrounding component
  rather than mixing both on the same surface.

### Component Design

- **Buttons**: Clear primary (solid), secondary (outline), tertiary (ghost) styles with `hover` and `focus` states.
- **Forms**: Labels above inputs. Consistent height for all form controls. Visible `focus` states (`focus:ring-2`).
- **Icons**: Use `lucide-react` consistently. Pair icons with text unless meaning is universally understood.
