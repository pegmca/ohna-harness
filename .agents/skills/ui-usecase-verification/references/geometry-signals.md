# Geometry and Interaction Signals

Use these checks when an experience claim is about density, clipping, scrolling,
overlap, focus, or keyboard behavior.

## Layout

- Capture `window.innerWidth/innerHeight`.
- Capture `getBoundingClientRect()` for the floating surface and each critical control.
- Assert the surface is inside the viewport with a small sub-pixel tolerance.
- Compare `document.documentElement.scrollWidth` with the viewport width.
- For a long list, assert `scrollHeight > clientHeight` and `overflow-y: auto|scroll`
  on the intended container.
- Scroll the inner list and assert the surface does not move outside the viewport and
  page `scrollY` does not change when page scrolling is not intended.
- Check long text with `white-space: nowrap`, `overflow: hidden`, and
  `text-overflow: ellipsis`; verify the action button’s hit box remains visible.

## Focus and Keyboard

- Record `document.activeElement` after open, move, select, and close.
- For a menu, verify an active option/descendant or a focused option.
- Press `ArrowUp` / `ArrowDown`, then `Enter`; assert the selected callback and closed state.
- Press `Escape`; assert only the popover closes and focus returns to its trigger.
- Verify `Shift+Enter` does not submit; `Enter` submits only when the composer is valid.
- For confirmation cards, tab to both native buttons and verify allow/deny each has a
  distinct result; timeout/deny must release the pending state.

## Evidence Discipline

jsdom does not provide reliable layout. When a measurement is unavailable:

1. extract the state decision into a pure function and test that state machine; and
2. retain or add a real-browser geometry script for the visual half.

Do not claim a real-browser layout passed because a mocked `scrollHeight` was returned.
