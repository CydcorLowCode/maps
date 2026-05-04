# Agent Handoff: Canvass Route Builder

## Product Goal

This project is evolving from a one-shot route generator into a feedback loop for learning how canvassers/managers prefer routes to be walked. The UI is not just for manual correction; it is a tool for discovering routing preferences so future initial runs require fewer edits.

The desired long-term behavior is:

1. Upload CSV.
2. Generate an initial route.
3. Let the user correct segment order/direction visually.
4. Save the corrected version.
5. Compare initial vs corrected routes.
6. Use recurring corrections to improve the initial heuristic.

## User Preferences Learned

The most important routing preference learned so far is that users think in terms of walkable street-side sweeps, not isolated block-side chunks.

For `route2.csv`, the original block/side ordering was technically organized but not walkable enough. The corrected pattern was:

- Start near the natural entry point.
- Walk one side across adjacent blocks.
- Cross at a logical endpoint.
- Walk the opposite side back.
- Choose direction based on endpoint continuity.

Example from the first saved correction:

- Indian Oaks:
  - `600-699 even` forward
  - `600-699 odd` forward
  - `700-799 odd` forward
  - `800-899 odd` forward
  - `900-999 odd` forward
  - `800-899 even` reverse
  - `700-799 even` reverse
- Osceola:
  - high odd block reverse
  - lower odd block reverse
  - lower even block forward
  - high even block forward

That correction reduced approximate inter-segment transition distance from about `835.6m` to `341.5m`, a roughly `59%` improvement. After implementing endpoint-aware side sweeping, the new initial route matched the saved correction at the segment level with zero remaining order/direction/stop-range changes.

## Important Heuristic Insight

Do not treat “block segmentation” as the final route order. Block/side segments are useful as editable units, but route sequencing should optimize how those units connect.

The current preferred heuristic is:

- Keep segments split by street, house-number block, and odd/even side.
- For initial sequencing, choose the next segment and direction by nearest endpoint.
- Allow segments to be reversed automatically.
- Preserve segment editability in the UI so future saved corrections can reveal new rules.

This means block/side segmentation is a control surface, while endpoint-aware side sweeping is the routing heuristic.

## UI Lessons

The map and segment controls need to support fast visual reasoning.

Important feedback:

- Users need to visually link map pins to segment cards.
- Segment cards should show stop ranges, not just abstract segment IDs.
- Card colors should match map pin/segment colors.
- Clicking a map pin should make the corresponding segment card obvious.
- Direction changes should be available inside the card itself, not in a separate table.
- The segment order table was too much like raw data; the user preferred card-based controls.
- Drag-and-drop should feel like manipulating route segments, not editing a spreadsheet.

The custom card component was introduced because the off-the-shelf sortable component only supported text cards and could not embed direction controls.

## Map Behavior Expectations

Map viewport stability matters. The user explicitly disliked the map resetting while making route edits.

Expected behavior:

- Moving/zooming the map should not trigger a Streamlit rerun.
- Dragging/reordering segments should not reset map position/zoom.
- After rerender, the map should restore the last browser-side viewport.

The solution moved viewport persistence into browser-side Leaflet/localStorage behavior instead of Streamlit state because returning map center/zoom through `st_folium` caused rerenders on every map movement.

## Learning Workflow Expectations

Saved route runs are meant to become a small training dataset of human corrections.

A saved learning bundle should preserve:

- Uploaded CSV.
- Initial ordered output.
- Initial segment summary.
- Corrected ordered output.
- Corrected segment summary.
- Comparison/change table.
- Settings used for generation.
- User notes about why corrections were made.

The comparison should focus on:

- Segment order changes.
- Direction changes.
- Stop range shifts.
- Repeated patterns that suggest heuristic improvements.

Do not overfit from a single route without looking for repetition across saved runs, but it is acceptable to promote a strongly obvious rule when the correction reveals a clear walking pattern, as happened with endpoint-aware side sweeps.

## Current Mental Model

Think of routing in layers:

1. **Parsing layer**: identify street, house number, parity, block.
2. **Editable segment layer**: street + block + side.
3. **Initial heuristic layer**: endpoint-aware side sweep over editable segments.
4. **Human correction layer**: drag segment cards, flip direction, inspect map.
5. **Learning layer**: compare correction to baseline and fold repeated preferences back into heuristics.

The UI should keep layers 2-4 transparent to the user, while the learning layer should help future agents/developers infer which layer needs adjustment.

## Cautions For Future Work

- Avoid making the UI spreadsheet-heavy again unless the user asks for tabular editing.
- Avoid reintroducing map rerenders from pan/zoom by returning map viewport state to Streamlit.
- Be careful with “direction”: if the heuristic already reversed a segment, applying a user override of `reverse` should not double-reverse it.
- Segment colors are order-based and regenerate when order changes; that is okay as long as cards and pins match after regeneration.
- The saved correction data is more valuable than any one-off manual assumption. Prefer analyzing saved runs before changing heuristics again.

## Good Next Steps

- Add aggregate analysis across multiple saved runs.
- Detect repeated correction patterns automatically, such as:
  - side sweep preference by street geometry,
  - common side-first choices,
  - repeated direction flips,
  - recurring block order changes.
- Add “Apply learned heuristic preview” once multiple saved runs exist.
- Consider scoring initial routes by endpoint transition distance and exposing that score in the learning panel.
