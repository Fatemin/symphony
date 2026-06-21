import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// SYM-70: durable WCAG-AA guard for the neutral text tokens. Pure node:test + node:fs — imports NO
// server module, so it needs no setupEnv(). It reads the real globals.css and recomputes the
// contrast ratios, so it fails red the moment a neutral text token (fg/muted/subtle) drops below
// AA on any surface in either theme, and pins the legibility hierarchy. The original SYM-70 bug
// (dark --color-subtle #475569 ≈ 2.6:1) and the light-theme regressions it surfaced (light subtle
// AND muted also failed AA — the issue title emphasised only the dark background) are exactly what
// this catches.
//
// SCOPE: only the NEUTRAL text tokens (fg/muted/subtle) are asserted here. The colored semantic /
// status tokens (success/warning/danger/info, todo/progress/review/done/urgent/high/medium) render
// on derived color-mix tints — NOT the raw surfaces below — and were AA-tuned under SYM-59, so
// folding them in would mean modelling those tinted backgrounds. Left out on purpose.

const css = readFileSync(new URL('../src/web/globals.css', import.meta.url), 'utf8');

// Extract a single CSS rule body by its selector header. Both blocks we read (`@theme` and
// `:root[data-theme='light']`) contain only flat property declarations (no nested braces), so the
// first `}` after the opening `{` is the block's close. Scoping each token lookup to its own block
// also keeps us clear of the SEPARATE `:root { --elev-* }` block lower in the file.
function block(header: string): string {
  const start = css.indexOf(header);
  assert.notEqual(start, -1, `globals.css block not found: ${header}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function token(blockText: string, name: string): string {
  const m = blockText.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  const hex = m?.[1];
  assert.ok(hex, `token not found: --color-${name}`);
  return hex;
}

// WCAG 2.1 relative luminance + contrast ratio (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
// Channels read by hex offset (R=0, G=2, B=4) — no array indexing, so it's clean under
// noUncheckedIndexedAccess.
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const channel = (offset: number): number => {
    const v = parseInt(c.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
// Surfaces a text token can actually land on (from globals.css §2). The binding worst case is the
// LIGHTEST dark surface (panel-2 #1b1f2a) for light-on-dark, and the DARKEST light surface
// (panel-2 #f1f5f9) for dark-on-light — but we assert every surface so a future surface tweak can't
// silently break a token. Placeholders render on bg-2 (inputClass `bg-bg-2`), covered here too.
const SURFACES = ['bg', 'bg-2', 'panel', 'panel-2'];
const TEXT_TOKENS = ['fg', 'muted', 'subtle'];

const themes = {
  dark: block('@theme'),
  light: block(":root[data-theme='light']"),
};

for (const [theme, blockText] of Object.entries(themes)) {
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, token(blockText, s)]));
  for (const name of TEXT_TOKENS) {
    test(`${theme} --color-${name} meets WCAG AA (>=${AA}:1) on every surface`, () => {
      const fg = token(blockText, name);
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const ratio = contrast(fg, surface);
        assert.ok(
          ratio >= AA,
          `${theme} --color-${name} (${fg}) on --color-${surfaceName} (${surface}) is ${ratio.toFixed(2)}:1 — below AA ${AA}:1`,
        );
      }
    });
  }
}

// Legibility hierarchy: fg is the strongest contrast, subtle the weakest. On DARK that means
// brightest→dimmest (descending luminance fg>muted>subtle); on LIGHT it inverts (darkest→lightest,
// ascending luminance fg<muted<subtle). Keeping subtle dimmer/lighter than muted preserves the
// visual rank even after both were raised to clear AA.
test('dark neutral text keeps fg > muted > subtle by luminance', () => {
  const dark = themes.dark;
  const fg = luminance(token(dark, 'fg'));
  const muted = luminance(token(dark, 'muted'));
  const subtle = luminance(token(dark, 'subtle'));
  assert.ok(fg > muted, `dark fg L=${fg.toFixed(4)} must exceed muted L=${muted.toFixed(4)}`);
  assert.ok(muted > subtle, `dark muted L=${muted.toFixed(4)} must exceed subtle L=${subtle.toFixed(4)}`);
});

test('light neutral text keeps fg < muted < subtle by luminance', () => {
  const light = themes.light;
  const fg = luminance(token(light, 'fg'));
  const muted = luminance(token(light, 'muted'));
  const subtle = luminance(token(light, 'subtle'));
  assert.ok(fg < muted, `light fg L=${fg.toFixed(4)} must stay below muted L=${muted.toFixed(4)}`);
  assert.ok(muted < subtle, `light muted L=${muted.toFixed(4)} must stay below subtle L=${subtle.toFixed(4)}`);
});
