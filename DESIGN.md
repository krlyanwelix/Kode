# Design system — web/

The browser UI is one surface with one job: read a coding agent's transcript, watch
what it touches, and steer it. Everything below is the contract the CSS keeps.

## Type

| Role | Token | Size | Weight |
| --- | --- | --- | --- |
| Session title (h1) | `--fs-lg` | 20px | 700 |
| Section title (h2) | `--fs-title` | 24px | 650 |
| Section heading (h3) | `--fs-sm` | 13px | 600 |
| Message body | `--fs-base` | 15px / 1.62 | 400 |
| Interface chrome (buttons, tabs) | `--fs-xs` | 12px | 500–600 |
| Metadata (turns, model, hints) | `--fs-xs` | 12px | 400–500 |
| Code | `--fs-sm` | 13px | 400 |

- Latin: self-hosted **Fira Sans** (400/500/600/700). Code: **Fira Code** (400/500).
- CJK: self-hosted **Noto Sans SC** (400/600), matched by `unicode-range` on the CJK
  blocks only, so Latin never falls through to it.
- No external font requests. No web-font loading state: `font-display: swap` with a
  system stack behind it.
- Long-form answers wrap at the bubble width (≈75ch at 1440); no justified text.

## Color

Every surface, line and ink step is a token; the dark theme redefines tokens only.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#fafafa` | `#111111` | Page |
| `--panel` | `#ffffff` | `#1a1a1a` | Sidebar, cards, composer |
| `--panel-soft` | `#fbfbfb` | `#202020` | Hover, inset blocks |
| `--user` | `#f4f4f4` | `#262626` | User message bubble |
| `--line` | `#e9e9e9` | `#333333` | Default hairline |
| `--line-soft` | `#f0f0f0` | `#262626` | Section separators |
| `--line-strong` | `#d6d6d6` | `#454545` | Input borders, rails |
| `--ink` | `#151515` | `#f0f0f0` | Primary text |
| `--ink-2` | `#4a4a4a` | `#bdbdbd` | Secondary text |
| `--ink-3` | `#6b6b6b` | `#8f8f8f` | Metadata |
| `--ink-4` | `#9b9b9b` | `#6b6b6b` | Disabled |
| `--accent` | `#151515` | `#f0f0f0` | Links, focus, active marks |
| `--accent-fill` | `#151515` | `#f0f0f0` | Primary button fill |
| `--accent-soft` | `#f1f1f1` | `#2a2a2a` | Selection wash |
| `--danger` | `#a33a3a` | `#e08d80` | Errors |
| `--danger-soft` | `#fbf0f0` | `#3a2222` | Error wash |
| `--success` | `#2f7a58` | `#74b795` | Online dot only |

Rules that keep this honest:

- **One accent, and it is ink.** The palette is monochrome: the accent is the same
  near-black as body text in light mode, and its inverse in dark mode. Hierarchy comes
  from weight, spacing and hairlines — not from hue.
- **Contrast floor.** Body text ≥ 6:1, metadata ≥ 5:1, large text ≥ 3:1, against the
  surface it actually sits on (measured, not assumed).
- **No literal colors in rules.** A hex value belongs in a token definition or nowhere.
- **Fill vs ink.** `--accent-fill` carries `--panel`-colored label; `--accent` is for text
  on neutral surfaces. They are separate tokens so dark mode cannot produce white-on-peach.

## Layout

- Two panels, not three: a 296px rail and the transcript. Each is a rounded card
  (16px) on a page-gutter of 12px; the rail holds everything — sessions, run status,
  branch path, memories, workspace identity — and the transcript is the only thing
  that scrolls.
- The rail is graded: title, search, New session and the recent list are always
  visible. Everything else lives in two disclosure rows — **Session** (status, model,
  context meter, tools used, path, capabilities) and **Memories** — closed by default.
  An open group body scrolls inside itself (max 38vh) so the rail never grows past
  the viewport.
- Below 1024px the rail narrows to 264px. Below 760px it becomes a drawer that slides
  over the transcript with a scrim; the workspace is then the only card on screen and
  "Menu" in the header opens the rail.
- Spacing steps: 4 / 8 / 12 / 16 / 24 / 32. Group bodies are inset cards
  (`--panel-soft`, 10px radius) rather than unbounded lists.
- Message column maxes at 760px, aligned left for the agent and right for the reader.
  Bubbles size to content (no stretched full-width answers for short replies).
- No decorative icons and no shortcut chrome: buttons say what they do (Menu, Sessions,
  Attach, Refresh, Search, Close), and key hints live only in the empty state.
- Everything has a focus ring: `outline: 2px solid var(--accent)` with `outline-offset: 2px`,
  or `box-shadow` on inputs that clip.

## Motion

- Three animations, all functional: message entrance (4px rise), search panel entrance
  (2px drop), tool output reveal (fade). Durations 120–160ms.
- Nothing loops, nothing bounces, nothing animates color on its own.
- All of it sits behind `@media (prefers-reduced-motion: no-preference)`.

## States

- **Busy** is owned by `.run-status[data-state]` (`idle` / `working` / `error`) and the
  composer's Send↔Stop swap; both read from the same event stream.
- **Streaming** renders plain text (`pre-wrap`) and switches to parsed Markdown once the
  turn settles — one parse per turn, not per token.
- **Empty** shows what is true of this workspace (tools, context budget, shortcuts) and two
  real prompts; it never uses illustration or placeholder product copy.
- **Error** is a notice with a Retry action, not a modal.
- `[hidden]` is global and `!important`; nothing relies on a class to hide.

## Content

- The UI speaks in short, literal sentences. No exclamation marks, no emoji, no
  "Oops!". Status text describes what the agent is doing ("Running a tool", "bash…").
- Numbers are the real ones: context usage is the last turn's prompt tokens, tool counts
  come from the turn, workspace name comes from `/api/health`.
- No invented plan names, avatars, or account chrome.
