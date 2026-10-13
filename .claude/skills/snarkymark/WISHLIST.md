# Wishlist

Editor features the user asked for on 2026-10-13. Not designed yet: each has open questions to settle
(one at a time, with the user) before building. Settled answers move into SKILL.md.

- **Line weight −/+.** Replace the 3 fixed sizes with − / value / + in the style dock, the default in the
  middle. Open: step size and range; does it also set the highlighter and the text/callout border?
- **Remember the last style.** Color and weight (or font size) carry over to the next shape and the next
  window. Open: per tool or one shared style? Stored where (localStorage, like Save's format)?
- **Callout arrow while typing.** Today the arrow (tail) disappears while the callout's text is being
  typed, so it can look like the drag didn't work. Keep the tail drawn during the edit.
- **Polygon tool.** Open: click to add points, close by double-click or clicking the first point? Filled
  like rect (filled black redacts)? Shift snaps edges to 45°? Key letter?
- **Fill patterns:** hash, diagonal, vertical, grid, with a density slider that scales. Open: which shapes
  (rect, ellipse, cloud, polygon, callout box)? Does a pattern fill still count as a redaction (no)?
- **Highlighter mode for fills, hatches and lines:** see-through ink that tints instead of covering (like
  the highlighter tool). Open: a per-shape toggle in the dock? Same blend as the highlighter?
- **Text and callout colors:** separate fill, text and line colors. Open: three swatch rows, or one row
  plus a target picker (fill / text / line)?
- **Re-croppable crop.** Pressing Crop again shows the whole capture with the current crop as an
  adjustable box; crops go on the undo stack. Today: "Undo crop" returns to the full capture and a crop
  is applied destructively. Open: keep the separate Undo crop button once crop is undoable?
