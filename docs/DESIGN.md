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
| `--color-muted` | `#8b93a7` | `#54637a` | Secondary text |
| `--color-subtle` | `#7e8ca3` | `#5b6b82` | Tertiary / placeholder text |

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

**Neutral text tokens meet AA on every surface (SYM-70).** `fg`/`muted`/`subtle` carry real content
(column counts, "No issues"/"No activity yet." placeholders, timestamps, input placeholders), so each
must clear 4.5:1 on the worst-case surface it can land on — the *lightest* dark surface (`panel-2`
`#1b1f2a`) and the *darkest* light surface (`panel-2` `#f1f5f9`). The pre-SYM-70 values failed: dark
`subtle` ≈ 2.2:1, and (despite the issue flagging only dark) light `muted` 4.34:1 and light `subtle`
2.34:1. Corrected, with the worst-case ratio on the binding `panel-2` surface:

| Token | Theme | Old → New | Ratio on `panel-2` |
|-------|-------|-----------|--------------------|
| `--color-subtle` | dark | `#475569` → `#7e8ca3` | 2.17 → **4.83** |
| `--color-muted` | light | `#64748b` → `#54637a` | 4.34 → **5.57** |
| `--color-subtle` | light | `#94a3b8` → `#5b6b82` | 2.34 → **4.95** |

The fix is a pure token-value change — every consumer reads the CSS variable (`text-subtle` /
`placeholder:text-subtle`), so all sites update at once. The legibility hierarchy is preserved
(`subtle` stays dimmer than `muted` in dark, lighter than `muted` in light). `tests/contrast.test.ts`
recomputes the WCAG ratios from `globals.css` on every `npm test`, so any token edit that drops a
neutral text token below AA — or inverts the hierarchy — fails CI. (Colored semantic/status tokens
render on derived `color-mix` tints, not raw surfaces, and are out of that test's scope; they were
AA-tuned under SYM-59.)

### Routing status/semantic call sites through tokens (SYM-73)

Status text/dots, badge surfaces, focus rings, and accent emphasis must consume the tokens above (or
the `Badge tone` API), never raw Tailwind palette classes (`bg-amber-500/15`, `text-emerald-400`,
`ring-indigo-500`): only tokens carry the light-mode override, and a hand-rolled
`focus-visible:ring-indigo-500` both hardcodes `#6366f1` and re-suppresses the global ring with
`outline-none`. SYM-73 routed the remaining call sites through tokens:

- **`lib/format.ts`** — `STATUS_META` dots, `PHASE_META`, `REVIEW_STATUS_META`, and `SKILL_SOURCE_META`
  use `var(--color-*)` solids/tints (status dots mirror their `color` label token; phase/running →
  `warning`, completed → `success`, failed → `danger`; github → `accent`, marketplace → `success`,
  manual → neutral surface). One edit here re-themes every consuming view.
- **Call sites** — `Ops` run-outcome + phase badges use `Badge tone`; `Board` moved/selected card
  emphasis + git-conflict badge, `ProjectTabs` active tab, `Review` active scope / draft banner /
  success text / converted rail, `Documentation` selected item, `ProjectSkills` disabled badges +
  checkbox `accent-[var(--color-accent)]`, and the `AskPanel` resize handle route through
  `--color-accent` / `-ring` / `-success` / `-danger` / `-warning`. Hand-rolled
  `focus-visible:ring-indigo-500` rings were deleted so the elements inherit the §3 global ring — the
  one exception is the 1.5px `AskPanel` resize handle, which keeps `ring-1 ring-inset
  ring-[var(--color-ring)]` because an offset outline would draw outside the thin handle.

**Intentionally raw — no 1:1 token exists (AC#4 exclusions).** Two `lib/format.ts` scales stay on raw
palette classes, commented in place: `REVIEW_SEVERITY_META` (a critical→low **grade ramp** of
red→orange→amber→slate — only red/amber have tokens, so converting the subset would fracture the ramp)
and `REVIEW_CATEGORY_META` (docs/code/ui_ux **categorical** hues sky/violet/teal — only sky has a near
token). Both await a dedicated grade/category token set. The brand `bg-indigo-600` button/message-bubble
fills stay raw by design (the `-600` shade keeps white text AA, see the AA paragraph above), as do
decorative standalone accent glyphs (`text-indigo-300` page/modal header icons) — a future consistency
pass can fold those icons in.

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
| `EmptyState` | Icon + title + description + optional action — every zero-data state. `compact` variant (borderless, low-padding, AA `text-muted`) for inline placeholders that sit INSIDE an existing frame (board column / activity feed / Ops section) instead of standing alone as a panel. |
| `ErrorState` | Danger-tinted icon + title + description + optional **Retry** (recovery path). |
| `useModalDialog(onClose)` | Native-`<dialog>` lifecycle: `showModal()` on mount, scroll-lock, `close()` in cleanup (restores focus to the opener), Escape routed through React via `onCancel`. |
| `Modal` | Centered dialog built on `useModalDialog`: header (icon + title + close), scrolling body, footer slot; Escape + backdrop-click + focus restore; `aria-labelledby`/`aria-label`. |
| `ConfirmDialog` (SYM-72) | The shared destructive-action confirm, built on `Modal`. `danger` confirm button (overridable via `confirmVariant`) + safe-action `autoFocus` on Cancel; danger warning-triangle header `icon` by default; `pending`-aware (controls disable, confirm shows a `Spinner`, dismissal no-ops); auto-closes on the `pending` true→false edge so the spinner spans the request and a toast carries the outcome. `description` or a custom `children` body. |

**Migrated onto the dialog primitives:** `ApproveDialog`, the Board's **New-issue form** (SYM-65),
the `IssueDetail` Request-changes dialog, the `PathField` directory picker, and the **Review tab**'s
two per-batch confirms — batch-convert (SYM-66) and the danger delete (SYM-69) — now use `Modal`; the
`AskPanel` drawer uses `useModalDialog` directly (a right-anchored `<dialog>`) so it keeps its
drag-to-resize + persisted width while gaining focus-trap, Escape, and focus restoration. **All
destructive confirms route through `ConfirmDialog`** (SYM-72) — skill delete and review-batch delete;
the native `confirm()` is gone from the client.

---

## 5. UI states (the contract for every view)

Every data-backed view renders all of these; primitives make them consistent:

- **Loading** — `Loading` for a whole page/section; `Skeleton` for content-shaped placeholders (e.g.
  the Projects grid). For a long, open-ended async wait (an opaque agent call) use `PendingIndicator`
  (SYM-77) so the spinner is paired with a live elapsed counter — a slow run reads as in-progress, not
  hung. Never a bare "Loading…" string.
- **Empty** — `EmptyState` with an icon, a one-line title, a supporting sentence, and (where there's an
  obvious next step) an action. Inline placeholders that live inside an existing frame use the
  `EmptyState compact` variant (borderless, low-padding, AA `text-muted`) instead of a hand-rolled
  `<p>`: the Board column's dashed "No issues" placeholder (so five empty columns don't become five
  heavy panels), the IssueDetail activity feed's "No activity yet." hint, and the Ops section hints all
  share it.
- **Error** — `ErrorState` with a recovery path (`onRetry`) for failed queries (IssueDetail, Review,
  StoryTree, Documentation).
- **Success** — toasts via Sonner (unchanged); inline success affordances keep their semantic color.
- **Disabled** — controls use `disabled:opacity-50` + `cursor-not-allowed`; in-flight buttons set
  `loading` (spinner + `aria-busy`).
- **Focus** — visible ring on every interactive element (§3).

---

## 6. Accessibility rules

- **Contrast:** body/label text ≥ 4.5:1, large/secondary ≥ 3:1, in **both** themes. Verify light
  independently — never infer it from dark. The neutral text tokens (`fg`/`muted`/`subtle`) are
  AA-enforced automatically by `tests/contrast.test.ts` (SYM-70; see §2 "Neutral text tokens meet AA").
- **Keyboard:** every interactive element is reachable and shows the focus ring. Modals trap focus
  (native `<dialog>`), close on Escape, and restore focus to the trigger on close.
- **Landmarks:** the shell has a "Skip to content" link, an `aria-label`'d primary `<aside>`/`<nav>`,
  and a single `<main id="main-content">`.
- **Color is never the only signal:** status/severity always pair a dot/icon with a label. The
  decorative dot itself is `aria-hidden` (e.g. `<span aria-hidden …>`) so the paired text label isn't
  announced redundantly.
- **Motion:** all keyframes + transitions are disabled under `prefers-reduced-motion` (the
  `globals.css` guard now also covers `anim-modal-in` / `anim-drawer-in`). A reduced-motion user still
  gets a non-animated activity signal where one matters — `PendingIndicator`'s elapsed counter keeps
  ticking even though the spinner ring is frozen (SYM-77), so the timer is never gated on the
  preference.
- **Live regions:** a `role=status` / `aria-live=polite` region is implicitly `aria-atomic`, so any
  value that changes inside it re-announces the *whole* region. `PendingIndicator` (SYM-77) marks its
  per-second elapsed span `aria-hidden` for exactly this reason — only the static label is announced,
  once on appearance, instead of a per-tick number read aloud every second.
- **Icon-only controls** carry an `aria-label` reflecting intent; a stateful toggle also exposes its
  state (`aria-pressed`, or `role=checkbox` + `aria-checked`), and a slider-like handle (the Ask
  resizer) exposes all of `aria-valuemin` / `aria-valuenow` / `aria-valuemax`.

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
- **Tables (Ops):** below `lg` the Running (6-col) and History (10-col) tables reflow to stacked cards
  (`lg:hidden` card list / `hidden lg:block` table) — issue key + phase/outcome lead and stay visible,
  with the low-priority metrics (turns/tokens/duration/…) in a `flex-wrap` `<dl>` (the shared `Metric`)
  so nothing forces a wide horizontal scroll on phones. The `lg+` table keeps `overflow-x-auto` as a
  safety net. The retry-queue row stacks on mobile (`flex-col sm:flex-row`) so a long error wraps onto
  its own line instead of clipping; on `sm+` it truncates within `max-w-md`.
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
  swaps its rail for the `--color-success` token (SYM-73 — a status signal, distinct from the raw
  severity grade ramp it replaces; see §2), and replaces the footer with a success affordance — the
  resting rail color is the only per-grade value that ever changes, so the pattern stays data-driven
  from one metadata field.
- **Destructive confirm** (SYM-72, `ConfirmDialog`) — never call the native `confirm()` and never
  fire an irreversible action straight off a click. Hold the target in page/component state
  (`skillToDelete`, `confirmDeleteOpen`) and mount `{open && <ConfirmDialog … />}` so the dialog
  unmounts on cancel/settle. Pass the mutation's `isPending` as `pending` (the confirm spinner spans
  the request; the dialog auto-closes on settle, the toast reports the result); the confirm button
  stays `danger`, Cancel keeps `autoFocus`. The state lives where it survives the list refetch the
  action triggers — at the page for a list-row delete, on the row component for a self-contained one.
