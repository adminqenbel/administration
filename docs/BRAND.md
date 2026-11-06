# QenBel brand for QenBel Administration

Source of truth for the site: `D:\Qenbel\theme.css` (read only). The portal repo reuses it. This product follows the same look and voice.

## Look
- Flat and simple: white and pale blue, navy text, one blue for actions, thin rules. No glass, gradients, shadows or illustration clutter.
- Tokens: `--ink #071A44`, `--ink-2 rgba(7,26,68,.76)`, `--blue #1E55CC`, `--blue-dark #17449F`, `--navy #0B2A6B`, `--pale #F2F7FE`, `--hair rgba(7,26,68,.14)`.
- One family: **Hanken Grotesk** (variable, weights 300-800, upright + italic), served from our own origin (copy `fonts/hanken-grotesk*.woff2` from `D:\Qenbel\fonts`). No third-party fonts, scripts or trackers.
- Logo: the name set in type, `QenBel`, weight 700, letter-spacing -0.035em, no image mark. Favicon: rounded square, blue-to-navy, white "Q" (see `D:\Qenbel\favicon.svg`).
- Buttons: pill (`border-radius: 999px`), solid blue; ghost variant for secondary. Chips: pill with hairline border. Focus ring: 3px blue, 3px offset. Selection: blue on white.
- Headings: light (300) with tight tracking; emphasis in bold italic blue (e.g. headline pair). Rows and lists separated by hairlines, not cards. One solid navy block per page at most (contact/CTA).
- Dashboard density: this is a working tool, so keep the same tokens but use tighter spacing, system-level clarity and tabular numerals for money, counts and times. Dark mode is out of scope for v1.
- Accessibility: visible focus, 4.5:1 contrast on text, `prefers-reduced-motion` respected, 44px touch targets on mobile and the Android shell.

## Voice
Plain, short, no hype. Say what a thing does. No promises, guarantees, prices or delivery dates in product copy. Brand is always written **QenBel**. Product name: **QenBel Administration**. Contact: contact@qenbel.site.

## Industry theming
Config packs change **words and layout** (terminology, nav, dashboard widgets), never the brand tokens. A salon and a clinic look like the same product.

## Where it lives
`packages/ui` exports `theme.css` (tokens + `@font-face`), base components (Button, Chip, Field, Table, Tabs, Dialog, Toast, PageHeader, EmptyState), and the Logo. Apps import from there only.
