# Symphony — Design System

The single reference for Symphony's web UI design language: the token system, the shared primitives,
the canonical UI states, and the accessibility + responsive rules every page must follow. It is the
counterpart to [`ARCHITECTURE.md` §8 (Frontend)](ARCHITECTURE.md#8-frontend-overview), which covers
*what* the pages do; this doc covers *how they should look and behave*.

> **Scope:** purely presentational. The design system never changes API shapes, the data model, or
> user-facing copy. The stack is React 19 + Vite + **Tailwind v4** (theme lives in `@theme` inside
> `src/web/globals.css` — there is no `tailwind.config`) + lucide-react icons. No component library is
> used; primitives are hand-rolled Tailwind in `src/web/components/ui.tsx`.

This system was established under SYM-59 ("使用 skill 重新 review 现有页面和功能"), applying the
`ui-ux-pro-max` design-intelligence skill's priority checklist (Accessibility → Touch/Interaction →
Layout/Responsive → Typography/Color → Animation → Forms/Feedback → Navigation) to a **developer-tool
dashboard** product type in both dark (default) and light themes.

---

## 1. Design direction

- **Product type:** developer-tool dashboard / admin panel — content-dense, keyboard-driven, used for
  long sessions. Optimise for scannability and low visual noise, not marketing flourish.
- **Style:** refined dark-first minimalism. One indigo accent (`#6366f1`), neutral slate surfaces,
  hairline borders, restrained elevation. Dark is the default (matches the anti-FOUC fallback); light
  is a first-class peer, not an afterthought.
- **Icons:** lucide-react only — one stroke family, sized 14–20px. No emoji as structural icons.
- **Motion:** short (≤240ms), opacity/transform-only, meaning-bearing (a card lifts when it moves
  columns; a page fades in on navigation). Everything is disabled under `prefers-reduced-motion`.

---

## 2. Token system (`src/web/globals.css`)

All design values are CSS custom properties in the `@theme` block (Tailwind v4 auto-generates the
`bg-*`/`text-*`/`border-*` utilities) or, where a value must differ per theme, plain `:root` variables
overridden under `:root[data-theme='light']`. **Token names are load-bearing** — they are referenced
both as auto-utilities (`bg-panel`, `text-fg`) and as arbitrary values (`text-[var(--color-todo)]`)
across every file. Extend the block; never rename.

### Color — surfaces & foreground (themed)

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--color-bg` | `#0b0d12` | `#f8fafc` | App background |
| `--color-bg-2` | `#0f1218` | `#ffffff` | Sidebar / inset fields |
| `--color-panel` | `#14171f` | `#ffffff` | Card / panel surface |
| `--color-panel-2` | `#1b1f2a` | `#f1f5f9` | Raised chip / nested surface |
| `--color-border` | `#262b38` | `#e2e8f0` | Hairline borders / dividers |
| `--color-hover` | `#222735` | `#e2e8f0` | Hover wash on ghost controls |
| `--color-fg` | `#e7e9ee` | `#1e293b` | Primary text (≥ AA on every surface) |
| `--color-muted` | `#8b93a7` | `#64748b` | Secondary text |
| `--color-subtle` | `#475569` | `#94a3b8` | Tertiary / placeholder text |

### Color — accent, focus & semantics (SYM-59 additions)

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--color-accent` | `#6366f1` | `#6366f1` | Brand accent (theme-independent) |
| `--color-accent-hover` | `#818cf8` | `#4f46e5` | Accent hover/links on surfaces |
| `--color-ring` | `#6366f1` | `#4f46e5` | Focus ring (see §5) |
| `--color-success` | `#34d399` | `#059669` | Success text + `Badge tone="success"` |
| `--color-warning` | `#fbbf24` | `#d97706` | Warning text + `Badge tone="warning"` |
| `--color-danger` | `#f87171` | `#dc2626` | Danger/error text + `ErrorState`, `Badge tone="danger"` |
| `--color-info` | `#7dd3fc` | `#0284c7` | Info text + `Badge tone="info"` |

Status/priority accents (`--color-todo/progress/review/done/urgent/high/medium`, SYM-5) are unchanged
and remain the source of truth for `lib/format.ts` badge/dot metadata.

**AA contrast.** The accent fills used for primary/danger buttons keep their `-600` shade
(`bg-indigo-600`, `bg-red-600`) so white button text stays ≥ 4.5:1 in both themes — `--color-accent`
(`#6366f1`) is for accents *on* surfaces (borders, links, icons), not for text backgrounds. Semantic
foregrounds darken in the light block so they keep AA on white. Subtle tone surfaces are derived from
a single foreground token via `color-mix(... <token> 16%, transparent)`, so each tone re-themes from
one source.

### Elevation (themed, not in `@theme`)

Three levels as `--elev-1/2/3`, kept as plain `:root` variables so each is re-themed per mode (dark
needs deeper, higher-opacity shadows than light). Consumed via `shadow-[var(--elev-N)]`:

- `--elev-1` — hover lift on cards/popovers.
- `--elev-2` — elevated panels / drawers (`Panel elevated`).
- `--elev-3` — modals + the off-canvas sidebar.

### Type & spacing scale

Tailwind's default scales are the system: text `xs 12 · sm 14 · base 16 · lg 18 · xl 20`, weights
`400` body / `500` labels / `600` headings, spacing on the 4px grid. Page titles are `text-lg`
(`sm:text-xl`); body is `text-sm`; dense metadata/chips use `text-xs` and the existing `text-[10px]` /
`text-[11px]` arbitrary sizes. Radii: `rounded` chips, `rounded-md` controls, `rounded-lg` panels,
`rounded-xl` modals.

---

## 3. Base layer (`globals.css @layer base`)

- **Global focus ring** — `:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px }`
  in `@layer base`, *below* the utilities layer, so any element that ships its own `outline-*`/`ring-*`
  utility still wins. This is the safety net that gives **every** interactive element a visible
  keyboard focus indicator (the form primitives layer their own token-matched ring on top).
- **Pointer affordance** — `button:not(:disabled) { cursor: pointer }` (Tailwind v4 preflight no longer
  sets it).
- **Native `<dialog>` base** — `dialog::backdrop` scrim + `max-height: 100dvh`. Top-layer rendering is
  why the Modal primitive is a `<dialog>`: it escapes the `.anim-page-in` transform's containing block
  (a non-`none` transform would otherwise clip/offset a `position:fixed` modal) and provides
  focus-trap + Escape + `::backdrop` for free.

---

## 4. Primitives (`src/web/components/ui.tsx`)

Every primitive is backward-compatible: existing call sites keep working; new props are additive.
Composition uses `cn()` (clsx + tailwind-merge) so a call site's `className` always overrides a
primitive default (last write wins).

| Primitive | Notes |
|-----------|-------|
| `cn(...)` | clsx + tailwind-merge class composer. |
| `Button` | `variant` (primary/subtle/ghost/danger) · `size` (sm/md) · `loading` (spinner + disabled + `aria-busy`). |
| `Badge` | `tone` (neutral/accent/success/warning/danger/info) — token-driven tints; `neutral` keeps the legacy "caller supplies className" behaviour. |
| `Panel` | `interactive` (hover border + transition for clickable cards) · `elevated` (`--elev-2` shadow). |
| `Field` | Label + optional hint (and a `required` danger-tinted asterisk) wrapping a control. |
| `Input` / `Textarea` / `Select` | Token focus ring, `aria-[invalid=true]` danger styling, disabled state. |
| `Spinner` | `border-current` so it tints to its context; honours reduced-motion. |
| `Loading` | Centered spinner + label — the standard page/section load state (replaces ad-hoc "Loading…"). |
| `PendingIndicator` / `useElapsedSeconds` | SYM-77: inline busy state for long async waits (Ask "Thinking…", Review "Reviewing…") — spinner + label + a live elapsed counter (shown once ≥ 1s). `since` is optional (self-start on mount, or a server `created_at` so the elapsed survives remount/poll). The elapsed span is `aria-hidden` inside the `role=status` region so it never re-announces per tick (§6). |
| `Skeleton` | Shimmer placeholder; `animate-pulse` + `motion-reduce:animate-none`. |
| `ProjectChip` | The colour-keyed project badge reused in every project header. |
| `PageHeader` | Standard header: optional back affordance + leading icon/chip, title + subtitle, badge slot, right-aligned actions. Unifies the old per-page `p-6`/`p-8` header divergence. |
| `EmptyState` | Icon + title + description + optional action — every zero-data state. |
| `ErrorState` | Danger-tinted icon + title + description + optional **Retry** (recovery path). |
| `useModalDialog(onClose)` | Native-`<dialog>` lifecycle: `showModal()` on mount, scroll-lock, `close()` in cleanup (restores focus to the opener), Escape routed through React via `onCancel`. |
| `Modal` | Centered dialog built on `useModalDialog`: header (icon + title + close), scrolling body, footer slot; Escape + backdrop-click + focus restore; `aria-labelledby`/`aria-label`. |

**Migrated onto the dialog primitives:** `ApproveDialog`, the Board's **New-issue form** (SYM-65),
the `IssueDetail` Request-changes dialog, and the `PathField` directory picker now use `Modal`; the
`AskPanel` drawer uses `useModalDialog` directly (a right-anchored `<dialog>`) so it keeps its
drag-to-resize + persisted width while gaining focus-trap, Escape, and focus restoration.

---

## 5. UI states (the contract for every view)

Every data-backed view renders all of these; primitives make them consistent:

- **Loading** — `Loading` for a whole page/section; `Skeleton` for content-shaped placeholders (e.g.
  the Projects grid). For a long, open-ended async wait (an opaque agent call) use `PendingIndicator`
  (SYM-77) so the spinner is paired with a live elapsed counter — a slow run reads as in-progress, not
  hung. Never a bare "Loading…" string.
- **Empty** — `EmptyState` with an icon, a one-line title, a supporting sentence, and (where there's an
  obvious next step) an action. Board columns use a lightweight dashed "No issues" placeholder so five
  empty columns don't become five heavy panels.
- **Error** — `ErrorState` with a recovery path (`onRetry`) for failed queries (IssueDetail, Review,
  StoryTree, Documentation).
- **Success** — toasts via Sonner (unchanged); inline success affordances keep their semantic color.
- **Disabled** — controls use `disabled:opacity-50` + `cursor-not-allowed`; in-flight buttons set
  `loading` (spinner + `aria-busy`).
- **Focus** — visible ring on every interactive element (§3).

---

## 6. Accessibility rules

- **Contrast:** body/label text ≥ 4.5:1, large/secondary ≥ 3:1, in **both** themes. Verify light
  independently — never infer it from dark.
- **Keyboard:** every interactive element is reachable and shows the focus ring. Modals trap focus
  (native `<dialog>`), close on Escape, and restore focus to the trigger on close.
- **Landmarks:** the shell has a "Skip to content" link, an `aria-label`'d primary `<aside>`/`<nav>`,
  and a single `<main id="main-content">`.
- **Color is never the only signal:** status/severity always pair a dot/icon with a label.
- **Motion:** all keyframes + transitions are disabled under `prefers-reduced-motion` (the
  `globals.css` guard now also covers `anim-modal-in` / `anim-drawer-in`). A reduced-motion user still
  gets a non-animated activity signal where one matters — `PendingIndicator`'s elapsed counter keeps
  ticking even though the spinner ring is frozen (SYM-77), so the timer is never gated on the
  preference.
- **Live regions:** a `role=status` / `aria-live=polite` region is implicitly `aria-atomic`, so any
  value that changes inside it re-announces the *whole* region. `PendingIndicator` (SYM-77) marks its
  per-second elapsed span `aria-hidden` for exactly this reason — only the static label is announced,
  once on appearance, instead of a per-tick number read aloud every second.
- **Icon-only buttons** carry an `aria-label`.

---

## 7. Responsive rules

- **Breakpoint:** `lg` (1024px) splits "desktop rail" from "mobile drawer".
- **Shell (`Layout.tsx`):** below `lg` the sidebar is an off-canvas `<dialog>`-free overlay (fixed,
  translate-X, backdrop, Escape/route-close, `invisible` when closed so its links leave the tab order);
  a mobile top bar holds the menu trigger + logo + theme toggle. At `lg+` the sidebar is the persistent
  static rail. The `.anim-page-in` main wrapper and all `localStorage` keys are unchanged.
- **Tabs (`ProjectTabs.tsx`):** scroll horizontally (`overflow-x-auto`, `shrink-0` items) instead of
  wrapping.
- **Forms:** grids collapse to a single column on mobile (`grid-cols-1 sm:grid-cols-2`,
  `grid-cols-2 sm:grid-cols-4`).
- **IssueDetail:** two-column at `lg` (sticky chain/activity rail); single column stacked below on
  mobile, with the activity feed pinned to a fixed height so it doesn't collapse under flex.
- **Tables (Ops):** wrapped in `overflow-x-auto`.
- **Board:** the column row scrolls horizontally; a focused column flows its cards into a responsive
  auto-fill grid.

---

## 8. Load-bearing invariants (do not break)

1. **Token names** are referenced as utilities and arbitrary values everywhere — extend `@theme`,
   never rename.
2. **`pageIn` keyframe ends at `transform: none`** and `.anim-page-in` uses `backwards` — any
   non-`none` transform makes the wrapper a containing block for `position:fixed` descendants. The
   Modal is a native `<dialog>` (top layer) specifically to sidestep this.
3. **`index.html` anti-FOUC script mirrors `theme.tsx#initialTheme`** — keep the `symphony-theme` key
   and the dark default.
4. **`src/shared/types.ts`** is shared with the server — never change it for visual work.
5. **Keep the `prefers-reduced-motion` guard** covering every animation, and keep the existing
   `localStorage` keys (`symphony.sidebar.expandedProjects`, `symphony.board.collapsedColumns`,
   `ask-panel-width`).
6. **Preserve copy/i18n** — `SidebarUsage` has intentional Chinese strings; leave them.

---

## 9. Composition patterns

Reusable layouts that compose the primitives above; reach for one before inventing a new shape.

- **Create / edit form dialog** (SYM-65, Board `NewIssueForm`; also `ApproveDialog`) — a `Modal`
  whose body is a real `<form id="…">` so the footer's submit `<Button type="submit" form="…">`
  drives it (the footer lives outside the body slot). Primary fields lead; secondary/run controls are
  grouped into a labeled `<fieldset>`/`<legend>` separated by a `border-t` divider (`field-grouping`,
  not progressive-disclosure — workflow controls stay visible). Required inputs get `Field required` +
  the input's own `required`. `onSubmit`/⌘·Ctrl+Enter submit; the close handler no-ops while the
  mutation is in flight so a half-built form can't be lost; success/error go to a toast. The grids
  collapse to one column on mobile (`grid-cols-1 sm:grid-cols-2|3`).
- **Graded item card** (SYM-61, Review tab `FindingCard`) — for a list of graded, actionable items
  the user triages. The grade is *labeled* by the section/group header it sits under (dot + label +
  count); the card reinforces it with a quiet **left grade-rail** (`border-l-2` + a per-grade
  `border-l-<color>/NN`, mirroring the header dot's color family) so severity is never carried by
  color alone. Inside: a single header line (type icon with an `aria-label` + title + an optional
  right-aligned area chip), the body as themed `<Markdown>`, and any long secondary block (acceptance
  criteria, logs) tucked behind a **progressive-disclosure** toggle — a `<button aria-expanded>` with
  a chevron that rotates via `transition-transform motion-reduce:transition-none`. The footer keeps
  **one primary CTA**; secondary actions are subordinate (`variant="ghost"`) and any quiet/reversible
  action (dismiss) is an icon-only `aria-label`'d button pushed to `ml-auto`, all on a `flex-wrap`
  row so they reflow on narrow widths. A resolved item (converted) de-emphasizes (`opacity-90`),
  swaps its rail for a success tint, and replaces the footer with a success affordance — the resting
  rail color is the only per-grade value that ever changes, so the pattern stays data-driven from one
  metadata field.
