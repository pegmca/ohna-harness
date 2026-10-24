# DESIGN.md

---
version: beta
name: Immersive Workbench
description: A Kimi-inspired, quiet and data-first dual-theme system for the Immersive financial research workspace.
theme: adaptive-light-dark
css: system.css
colors:
  light-canvas: "#FBFAF9"
  light-surface: "#FFFFFF"
  light-secondary: "#F5F5F5"
  light-text-primary: "rgba(0, 0, 0, 0.90)"
  dark-canvas: "#181817"
  dark-surface: "#121212"
  dark-secondary: "#1F1F1F"
  dark-text-primary: "rgba(255, 255, 255, 0.84)"
  primary-light: "#428475"
  primary-dark: "#89D7B7"
  market-up: "#FF3849"
  market-down: "#16C456"
typography:
  ui:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
  page-title:
    fontSize: "1.875rem"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "0"
  section-title:
    fontSize: "0.875rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0"
  body:
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0"
  body-sm:
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
    textTransform: "uppercase"
  code:
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
  16: "64px"
radius:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "999px"
motion:
  fast: "120ms"
  base: "160ms"
  slow: "240ms"
---

## Purpose

Immersive Workbench is a focused visual system for serious AI research tools and dense information surfaces. It gives AI coding agents a stable design language instead of asking them to "make it beautiful" from scratch.

The system is intentionally product-neutral. Product goals, workflows, domain entities, and screen-specific requirements should live in separate product documents such as `docs/IMMERSIVE_PRODUCT_DESIGN.md`.

## Design Philosophy

The interface should recede and the information should carry the attention. Immersive follows Kimi's calm workspace hierarchy while retaining the project's original green identity: warm near-white or neutral near-black canvas, low-contrast fills, restrained green actions, generous conversation whitespace, and on-demand execution details. It is optimized for scanning, comparison, research, and long working sessions.

Keywords:

- Precise
- Calm
- Data-first
- Trustworthy
- Dense but readable
- Operational rather than promotional
- Explainable AI by default

Avoid:

- Marketing-page hero layouts for tool surfaces.
- Decorative gradient blobs, bokeh, novelty backgrounds, or purely atmospheric visuals (a restrained ambient glow behind the canvas is acceptable; avoid content-level blobs).
- **Unrestrained** glassmorphism, heavy neon, or exaggerated shadows — glass blur is allowed, but only on floating layers (sidebar / drawer / dialog / toast), never on scrolling content surfaces.
- One-color interfaces where every highlight is a variation of the same hue.
- Low-contrast text used to fake sophistication.
- Layout shifts caused by hover, loading text, long IDs, or dynamic content.

## How AI Agents Should Use This File

Before generating UI, read this file and then read the product-specific document for the task. Use this file for visual language and component rules; use the product document for information architecture and domain content.

Default AI workflow:

1. Identify the product surface and user workflow.
2. Choose the smallest set of components from this design system.
3. Use semantic tokens and component anatomy instead of ad hoc color or spacing choices.
4. Implement reusable components before duplicating long class strings.
5. Verify desktop and mobile screenshots for overflow, overlap, disabled/loading states, and long-content behavior.

When using Stitch, v0, or similar tools, use this document as the design-system reference and keep generation prompts focused on layout, content, states, and interaction structure.

## Visual Tokens

### Color

Immersive supports light, dark, and system preferences. Both modes use the same semantic roles. Brand green is reserved for actions, focus, and selected states; financial red and green still use dedicated market tokens and must be paired with text or symbols. Depth comes from surface tiers and separators, not decorative shadows.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `canvas` | `#FBFAF9` | `#181817` | App background |
| `surface` | `#FFFFFF` | `#121212` | Panels and inputs |
| `elevated` | `#F5F5F5` | `#1F1F1F` | Hover and secondary surfaces |
| `muted` | `#EEEEEE` | `#292929` | Inactive controls |
| `border-subtle` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.08)` | Quiet separators |
| `border` | `rgba(0,0,0,.13)` | `rgba(255,255,255,.12)` | Default outlines |
| `text-primary` | `rgba(0,0,0,.90)` | `rgba(255,255,255,.84)` | Primary text |
| `text-secondary` | `rgba(0,0,0,.60)` | `rgba(255,255,255,.56)` | Supporting text |
| `primary` | `#428475` | `#89D7B7` | Action, focus and selection |
| `market-up` | `#FF3849` | `#FF4756` | A-share price increase |
| `market-down` | `#16C456` | `#16C456` | A-share price decrease |

Rules:

- Warm white and neutral black surfaces carry the layout; do not use brand green as a large page background.
- Primary green is for action, focus, selected state, and key icons. Do not flood the screen with it.
- Use semantic opacity tiers for secondary text instead of ad hoc gray values.
- Signal colors must be paired with text or icon labels. Never rely on color alone.
- Use darker soft backgrounds for error and warning states so text remains readable.
- JSON, logs, traces, and evidence panels should use calmer surfaces than primary content.

### Typography

Use system sans by default. Use monospace only for code, IDs, aligned numeric values, timestamps, and structured data.

| Level | Use | Size / Weight / Line |
| --- | --- | --- |
| `page-title` | Product or page title | 30px / 650 / 1.15 |
| `section-title` | Panel headers and compact headings | 14px / 650 / 1.3 |
| `body` | Main readable content | 15px / 400 / 1.6 |
| `body-sm` | Dense rows, metadata, helper copy | 13px / 400 / 1.5 |
| `label` | Eyebrows, small headers, tags | 12px / 600 / uppercase |
| `code` | JSON, IDs, logs, tool payloads | 12px / 500 / 1.5 |

Rules:

- Do not scale font size with viewport width.
- Do not use negative letter spacing.
- Keep hero-scale type out of dashboards and tool workspaces.
- Use tabular or monospace numbers when users compare metrics in columns.

### Spacing

The base spacing grid is 4px.

| Token | Value | Use |
| --- | --- | --- |
| `1` | 4px | Icon gaps, hairline offsets |
| `2` | 8px | Inline gaps, compact controls |
| `3` | 12px | Dense row padding |
| `4` | 16px | Default component gap |
| `5` | 20px | Panel padding |
| `6` | 24px | Section padding |
| `8` | 32px | Major layout gap |
| `10` | 40px | Wide layout gap |
| `12` | 48px | Page-level rhythm |
| `16` | 64px | Large separation only |

Rules:

- Dense tools should prefer 12px to 24px internal rhythm.
- Repeated cards should align to a consistent grid and not drift by content length.
- Keep toolbar and control dimensions stable so state changes do not resize the layout.

### Shape

Immersive Workbench uses precise, restrained geometry.

| Token | Value | Use |
| --- | --- | --- |
| `sm` | 4px | Tiny labels, code blocks |
| `md` | 6px | Inputs, badges, small buttons |
| `lg` | 8px | Panels, cards, main buttons |
| `xl` | 12px | Modals, drawers, major surfaces |
| `full` | 999px | Switches, circular icons, compact pills |

Rules:

- Default card and panel radius is 8px.
- Avoid `rounded-2xl` and larger unless the surface is intentionally large and rare.
- Do not put cards inside cards. Use dividers, rows, or sections instead.

### Border, Elevation, and Motion

Borders are the primary depth tool.

- Default border: 1px.
- Hover: raise one surface tier or strengthen the border.
- Focus: visible ring using the primary token.
- Shadow: reserved for modals, popovers, drawers, and command palettes.
- Motion: 120ms for pressed states, 160ms for hover/focus, 240ms for modal or drawer entry.

Do not animate layout dimensions for routine hover states.

## Layout Language

Immersive Workbench favors workbench layouts:

```text
Top bar:
  Product identity / navigation / global status / user actions

Primary workspace:
  Main task area plus supporting evidence or inspector area

Utility area:
  Filters, input dock, activity feed, trace panel, or command tools
```

Desktop patterns:

- Two-column workbench: main content with right inspector.
- Three-column workbench: navigation, primary document/task, inspector.
- Execution inspectors that contain charts or traces consume the remaining desktop width up to `1120px`, after reserving `280px` for navigation and at least `640px` for primary content. Below that viable split width, use an `88vw` right overlay.
- Dense dashboard: metric strip, table/list, detail drawer.
- Console: command input, result stream, structured diagnostics.

Mobile patterns:

- Collapse inspector panels into tabs, accordions, drawers, or stacked sections.
- Keep primary action and input reachable.
- Long IDs, code, logs, and JSON must wrap or scroll inside their own region.

## Component Anatomy

### Button

Variants:

- `primary`: solid primary fill for the main action.
- `secondary`: surface fill with border for supporting actions.
- `ghost`: transparent or subtle fill for low-emphasis actions.
- `danger`: destructive or irreversible actions only.

Rules:

- Icon-only buttons need an accessible name or tooltip.
- Loading buttons must disable repeat submission.
- Button height should be stable across states.
- Use icons from one library only; prefer lucide-react in React apps.

### Input and Textarea

Inputs sit on the surface tier with a clear border. Focus uses primary border plus focus ring. Error uses danger border plus explanatory text.

Rules:

- Always provide labels or accessible names.
- Placeholder text is not a replacement for labels in complex forms.
- Textareas used for prompts or research questions should support multiline content.
- Disabled state should remain legible and preserve layout.

### Badge and Chip

Badges express compact state, not paragraphs.

Use badges for:

- Status
- Type
- Intent
- Latency
- Priority
- Error code
- Version or mode

Rules:

- Keep labels short.
- Pair signal color with text.
- Avoid using badges as buttons unless they are explicitly interactive.

### Panel

Panels group related information. A panel should include:

- Header with title and optional icon.
- Optional status or action slot.
- Empty state.
- Loading state when data is async.
- Error state when the section can fail independently.
- Overflow behavior for long content.

### Tabs and Segmented Controls

Use tabs when multiple related views occupy the same area, especially on mobile.

Rules:

- Active tab needs a visible fill or border, not only text color.
- Tab labels should be short.
- Each tab panel should manage its own scroll if content is long.

### Table and Metric Grid

Use tables or metric grids for comparable data. Do not inflate numeric summaries into oversized decorative cards.

Rules:

- Values, units, period, and change should appear together.
- Align numbers for comparison.
- Use text and icons along with signal color for trends.
- Columns must not collapse in a way that hides the important value.

### Timeline

Use timelines for ordered events, workflows, logs, and execution traces.

Rules:

- Show event type, timestamp or duration, state, and summary.
- Hide large payloads behind expandable details.
- Use stable row height where possible.

### JSON and Code Blocks

Structured diagnostics should be readable without breaking the page.

Rules:

- Use monospace.
- Default to collapsed or bounded height for long data.
- Use `overflow-auto`.
- Allow long strings to wrap with `overflow-wrap: anywhere` when horizontal alignment is not required.

## Accessibility and Usability

Required:

- Keyboard reachable controls.
- Visible focus states.
- Sufficient contrast for text and state labels.
- Error states with text, not color alone.
- Loading and disabled states that preserve context.
- Empty states that tell the user what to do next without turning into documentation.
- Responsive validation for at least desktop, laptop, and mobile viewports.

## AI Prompt Template

Use this when asking an AI coding agent to implement or refine UI:

```text
Read DESIGN.md first, then read the product-specific design document and relevant implementation task card.

Use the Immersive Workbench visual system:
- Dark-first professional workbench
- Data-first hierarchy
- Stable panels, borders, and compact controls
- Primary color only for actions, focus, current state, and key icons
- No marketing hero layout unless the product document explicitly asks for one
- No decorative gradient blobs on content surfaces, no oversized round cards, or low-contrast text
- Glassmorphism (backdrop blur) is allowed on floating layers only — sidebar, drawer, dialog, toast — not on scrolling content

Use existing project technology and component boundaries.
Prefer reusable local UI components over repeated class strings.
Cover empty, loading, error, disabled, hover, focus, and long-content states.
Verify desktop and mobile layouts for overflow, overlap, and text clipping.
```

## Stitch / v0 Prompt Template

Use this to generate a visual reference, not production code:

```text
Create a professional AI workbench interface using a quiet, data-first design system.

PLATFORM: Web, desktop-first with responsive mobile behavior.

PAGE STRUCTURE:
1. Header:
   Compact top bar with product identity, navigation/status area, and primary controls.
2. Primary Workspace:
   Split-view workbench with a main task area and a supporting inspector/evidence area.
3. Data Surfaces:
   Include panels, metric grids, tables or lists, timeline/log area, and bounded structured-data details.
4. Interaction States:
   Include empty, loading, error, disabled, selected, hover, and long-content states.
5. Mobile:
   Convert secondary inspector panels into tabs, accordions, drawers, or stacked sections.

Do not use a marketing landing page layout. Prioritize clarity, density, and operational usability.
```

## CSS Implementation

The companion CSS implementation is `system.css`. It defines:

- CSS custom properties for tokens.
- Base typography and body styles.
- Utility classes for layout, surfaces, text, buttons, fields, badges, panels, tabs, metric grids, timelines, and code blocks.

Projects may either import `system.css` directly or translate the tokens into Tailwind/shadcn-style local components.
