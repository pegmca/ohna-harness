# DESIGN.md

---
version: alpha
name: Meridian
description: A quiet, precise, data-first design system for professional AI workspaces and research tools.
theme: dark-first
css: system.css
colors:
  canvas: "#161E17"
  surface: "#1B241D"
  elevated: "#202B23"
  muted: "#2C3A32"
  border-subtle: "rgba(255, 244, 225, 0.10)"
  border: "rgba(255, 244, 225, 0.18)"
  border-strong: "#428475"
  text-primary: "#FFF4E1"
  text-secondary: "rgba(255, 244, 225, 0.78)"
  text-muted: "rgba(255, 244, 225, 0.56)"
  text-disabled: "rgba(255, 244, 225, 0.36)"
  primary: "#89D7B7"
  primary-hover: "#A6E6CC"
  primary-pressed: "#428475"
  success: "#89D7B7"
  warning: "#D9A441"
  danger: "#D36A5F"
  info: "#428475"
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

Meridian is a generic visual system for building serious AI products, research tools, dashboards, consoles, and other dense information surfaces. It gives AI coding agents a stable design language instead of asking them to "make it beautiful" from scratch.

The system is intentionally product-neutral. Product goals, workflows, domain entities, and screen-specific requirements should live in separate product documents such as `docs/IMMERSIVE_PRODUCT_DESIGN.md`.

## Design Philosophy

The interface should recede and the information should carry the attention. Meridian uses a near-black green canvas, neutral dark surfaces, crisp low-contrast borders, restrained green accent color, and stable layout rhythm. It is optimized for scanning, comparison, debugging, and long working sessions.

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
- Decorative gradient blobs, bokeh, novelty backgrounds, or purely atmospheric visuals.
- Excessive glassmorphism, heavy neon, exaggerated shadows, or large rounded cards.
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

Meridian is dark-first. The base experience should read as a deep dark interface, not as an all-green page. The left rail, panels, cards, and inputs should stay in near-neutral dark surface tiers. Green is the product accent for actions, focus, selected states, and status highlights. Depth comes from surface tiers and borders, not from decorative shadows.

| Token | Hex | Role |
| --- | --- | --- |
| `canvas` | `#161E17` | App background and outer viewport |
| `surface` | `#1B241D` | Panels, cards, inputs, list rows |
| `elevated` | `#202B23` | Active tabs, hover surfaces, popovers |
| `muted` | `#2C3A32` | Subtle fills and inactive controls |
| `border-subtle` | `rgba(255, 244, 225, 0.10)` | Quiet separators |
| `border` | `rgba(255, 244, 225, 0.18)` | Default component outline |
| `border-strong` | `#428475` | Focused structures and emphasized dividers |
| `text-primary` | `#FFF4E1` | Primary readable text |
| `text-secondary` | `rgba(255, 244, 225, 0.78)` | Supporting copy |
| `text-muted` | `rgba(255, 244, 225, 0.56)` | Metadata and captions |
| `text-disabled` | `rgba(255, 244, 225, 0.36)` | Disabled copy |
| `primary` | `#89D7B7` | Primary action, focus, current state |
| `primary-hover` | `#A6E6CC` | Hover state for primary actions |
| `primary-pressed` | `#428475` | Pressed state for primary actions |
| `success` | `#89D7B7` | Completed, positive, available |
| `warning` | `#D9A441` | Caution, incomplete, needs review |
| `danger` | `#D36A5F` | Error, destructive, failed |
| `info` | `#428475` | Neutral informational highlight |

Rules:

- `#161E17` is the dominant canvas, and `#1B241D` / `#202B23` are the main large-surface colors. Do not use `#428475` or `#89D7B7` as large page backgrounds.
- Primary green is for action, focus, selected state, and key icons. Do not flood the screen with it.
- `#428475` is a secondary accent for pressed states, emphasized borders, and compact informational states, not a sidebar or panel fill.
- Warm text `#FFF4E1` should provide readability and contrast; use opacity variants for secondary text rather than introducing gray-blue copy.
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

Meridian uses precise, restrained geometry.

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

Meridian favors workbench layouts:

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

Use the Meridian visual system:
- Dark-first professional workbench
- Data-first hierarchy
- Stable panels, borders, and compact controls
- Primary color only for actions, focus, current state, and key icons
- No marketing hero layout unless the product document explicitly asks for one
- No decorative gradient blobs, excessive glassmorphism, oversized round cards, or low-contrast text

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
