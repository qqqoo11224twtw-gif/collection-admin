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

- Reach for the semantic tokens first: `text-foreground`, `text-muted-foreground`,
  `bg-card`, `border-border`, `bg-destructive`. They exist so that one meaning
  has one value.
- **Anything with a status meaning — error, success, warning, info — should go
  through a token, not a palette class.** The failure mode is not "someone used
  `text-red-600`", it is the same red arriving as `red-500` in one file,
  `red-600` in another and `red-700` in a third, until nothing matches. Picking
  a shade is a decision that should be made once.
- Palette classes are fine for things that carry no status: chart series,
  illustrations, one-off decorative accents. Do not invent a token for a color
  used once.
- Use the primary color for primary actions only.

### Typography

Application UI uses Tailwind's named type steps only. Do **not** introduce
arbitrary font sizes such as `text-[15px]` for normal product surfaces. If a
screen feels off, first adjust role assignment, weight, color, spacing, or
layout.

The default standard is the **Chinese-friendly dashboard** scale:

| Element | Class | Size | Notes |
|---|---|---:|---|
| Page title | `text-2xl` | 24px | Top-level screen title. |
| Dashboard metric value | `text-2xl` | 24px | Can go larger only when the metric is the whole card's purpose. |
| Section heading | `text-lg` | 18px | Only when the content below is not self-explanatory. |
| Tabs | `text-base` | 16px | Use `font-medium`, not `font-semibold`, unless the surrounding UI is very quiet. |
| Prominent card title | `text-base` | 16px | Settings cards, important form groups, and strong local headings. |
| Normal card title | `text-sm` | 14px | Dense dashboard cards where the value/content carries the emphasis. |
| Body copy | `text-sm` | 14px | The floor for readable application text. |
| Table cells | `text-sm` | 14px | Use muted color, not smaller type, for secondary columns. |
| Form label | `text-sm font-medium` | 14px | Labels stay readable; don't shrink them to make forms look dense. |
| Form description / help text | `text-sm text-muted-foreground` | 14px | Explanatory copy is still body text. |
| Sidebar item | `text-sm` | 14px | Matches shadcn Sidebar defaults. |
| Badge / count / compact metadata | `text-xs` | 12px | Short status labels, counts, timestamps, and dense metadata only. |
| Short monospace id / key fragment | `text-xs font-mono` | 12px | Use `text-sm font-mono` when the value is important or must be copied. |
| Code block | `text-xs font-mono` | 12px | Acceptable because code is scanned differently and usually wrapped in a block. |

- **14px is the body floor.** Do not use `text-xs` for explanatory copy, form
  help, table content, card descriptions, or Chinese sentences.
- **Secondary text is usually `text-sm text-muted-foreground`, not `text-xs`.**
  Lowering contrast is a stronger and more readable signal than shrinking.
- **`text-xs` is for compact metadata only.** Good uses: badges, counts,
  timestamps, short ids, chart axis labels, tiny helper labels inside a dense
  technical display.
- **Avoid `text-sm` + caps as a section heading.** That puts the label at the
  same size as the content it labels, so hierarchy rests entirely on styling
  tricks.
- Stick to a few font weights: `font-normal`, `font-medium`, `font-semibold`.
  Prefer moving up one type token before stacking many weights.
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
