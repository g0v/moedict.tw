# Cross-Strait Vocabulary Table and Navigation Hover Design

**Goal:** Turn the malformed `同實異名` semicolon listing into an accessible Taiwan/Mainland comparison table, and remove the desktop submenu hover gap that prevents a slow pointer from reaching `同實異名`.

## Scope

Two narrow frontend changes in the current branch:

1. Render only the Cross-Strait `同實異名` category as a two-column table.
2. Give desktop nested navigation menus a continuous pointer hit path.

No new API route, R2 object, data-processing job, automatic pairing, or other category redesign is included.

## Authoritative Pair Contract

`data/dictionary/c/=同實異名.json` contains 753 values in the compact form `;臺灣詞;大陸詞`, for example `;三角皮帶;三角帶`.

The source contract is explicit upstream: [`g0v/moedict-data-csld/兩岸同實異名.csv`](https://raw.githubusercontent.com/g0v/moedict-data-csld/master/%E5%85%A9%E5%B2%B8%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D.csv) starts with `臺灣詞,,,大陸詞,,,差異別`. The generated JSON preserves that field order. The parser implementation will retain a short source-reference comment beside the exact-shape check.

## Comparison Table

### Activation and parsing

`ListView` will take the comparison-table path only when both conditions hold:

- `lang === 'c'`
- `category === '同實異名'`

It will parse a row only when splitting on `;` yields exactly `['', taiwanTerm, mainlandTerm]` and both terms are non-empty. Nonmatching values remain ordinary list values rather than being guessed or altered.

All other categories retain their current one-link-per-word list rendering.

### Markup and links

The comparison path renders a semantic `<table>` with `<thead>`, scoped column headers, and one `<tr>` per parsed pair:

| Header | Value |
| --- | --- |
| `🇹🇼 臺灣用語` | The first JSON field (`臺灣詞`) |
| `🇨🇳 大陸用語` | The second JSON field (`大陸詞`) |

The flag glyphs are supplemental visual identifiers, as requested. The visible Chinese labels preserve an unambiguous textual name for assistive technology and environments that cannot render flags.

Each term is an independent React Router `Link` created with `wordPath('c', term)`. A row therefore links to its two actual dictionary entries rather than navigating to an invalid semicolon-containing headword.

### Search and small screens

The existing category keyword search remains enabled because the category exceeds the threshold. Its filter matches either Taiwan or Mainland term, not the compact source string.

The table has a constrained wrapper and fixed two-column layout. Terms may wrap at normal CJK line boundaries inside cells; narrow viewports do not acquire horizontal document overflow and do not collapse the pair into an ambiguous prose string.

## Desktop Submenu Pointer Path

`DropdownSubmenu` currently removes its `.hover` class immediately on `<li>` mouse leave. On desktop its child `.dropdownMenu` is fixed at the parent menu’s right boundary; the parent container border leaves a physical gap while moving between them.

At `min-width: 768px`, the submenu CSS will add a transparent, absolutely positioned `::before` pseudo-element extending several pixels left from the submenu. As a descendant of the menu-owning `<li>`, this bridge keeps the pointer inside that list item while it crosses from parent to child.

No close timeout, React state, menu-coordinate overlap, or mobile CSS change is required. Click-to-pin behavior remains unchanged.

## Verification Contract

Tests are behavior-oriented and test-first:

- A focused ListView test initially fails because the current output has no table or independent cell links. It then proves exact pair parsing, `🇹🇼 臺灣用語` / `🇨🇳 大陸用語` headers, both generated `c`-dictionary routes, keyword matches in either column, and unchanged ordinary-category rendering.
- A Chromium Playwright test initially fails because a slow, stepped `mouse.move` from the Cross-Strait `分類索引` parent toward `同實異名` loses the submenu. It then proves the target remains visible and can be clicked after the bridge is added.
- A narrow viewport Playwright assertion proves the comparison table’s bounding box does not exceed the document viewport.
- Focused unit/E2E tests, TypeScript checking, and linting run after implementation. The full suite is not required unless a focused result reveals unrelated coupling.

## Out of Scope

- Deriving pair rows from the flat `臺灣用語` or `大陸用語` categories.
- Editing the authoritative Cross-Strait vocabulary source.
- Changing headers, layout, or filtering for other categories.
- Reworking navigation state or touch/mobile submenu behavior.
