"use client";

import { useEffect } from "react";
import type L from "leaflet";

/**
 * Lets the user pan the Leaflet map with the right mouse button while a draw /
 * zone-edit overlay has taken over the left button. We don't re-enable
 * `map.dragging` because that grabs left-click; instead we manually call
 * `map.panBy` from raw pointer deltas.
 *
 * Side effects:
 *   - Right-button pointerdown/move/up are captured (capture phase) so they
 *     never reach the overlay's own left-button handler.
 *   - The native context menu is suppressed while the hook is mounted.
 */
export function useRightClickPan(
  map: L.Map | null,
  el: HTMLElement | null,
): void {
  useEffect(() => {
    if (!map || !el) return;

    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let pointerId: number | null = null;

    const onDown = (e: PointerEvent) => {
      // button === 2 is right; for touch with `pointerType === "touch"` it's
      // always 0 — we don't bind right-click pan there.
      if (e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      pointerId = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw if the pointer is already captured
        // elsewhere — ignore and rely on window-level listeners.
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Negate: dragging right should move the map view left under the cursor.
      map.panBy([-dx, -dy], { animate: false });
    };

    const onUp = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      e.preventDefault();
      e.stopPropagation();
      if (pointerId !== null) {
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          // already released
        }
        pointerId = null;
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    // Capture phase so we win over the overlay's left-button bubble handlers.
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove, true);
    el.addEventListener("pointerup", onUp, true);
    el.addEventListener("pointercancel", onUp, true);
    el.addEventListener("contextmenu", onContextMenu);

    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove, true);
      el.removeEventListener("pointerup", onUp, true);
      el.removeEventListener("pointercancel", onUp, true);
      el.removeEventListener("contextmenu", onContextMenu);
    };
  }, [map, el]);
}
