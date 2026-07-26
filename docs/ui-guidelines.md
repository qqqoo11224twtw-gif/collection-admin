# UI Guidelines

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

- Use Tailwind's font-size scale (`text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`).
- Stick to a few font weights (`font-normal`, `font-medium`, `font-semibold`).
- Create hierarchy through font weight and color, not just size.

### Visual Hierarchy and Depth

- Use subtle shadows (`shadow-sm`, `shadow-md`) for elevation.
- Prefer box shadows or background colors over borders. When using borders, keep them subtle (`border-slate-200`).

### Component Design

- **Buttons**: Clear primary (solid), secondary (outline), tertiary (ghost) styles with `hover` and `focus` states.
- **Forms**: Labels above inputs. Consistent height for all form controls. Visible `focus` states (`focus:ring-2`).
- **Icons**: Use `lucide-react` consistently. Pair icons with text unless meaning is universally understood.
