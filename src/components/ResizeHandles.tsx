import { IS_MAC } from "@/lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo } from "react";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

type Edge = {
  direction: ResizeDirection;
  className: string;
  cursor: string;
  label: string;
};

const EDGES: Edge[] = [
  {
    direction: "North",
    cursor: "ns-resize",
    className: "top-0 right-2 left-2 h-1.5",
    label: "Resize from top edge",
  },
  {
    direction: "South",
    cursor: "ns-resize",
    className: "right-2 bottom-0 left-2 h-1.5",
    label: "Resize from bottom edge",
  },
  {
    direction: "West",
    cursor: "ew-resize",
    className: "top-2 bottom-2 left-0 w-1.5",
    label: "Resize from left edge",
  },
  {
    direction: "East",
    cursor: "ew-resize",
    className: "top-2 right-0 bottom-2 w-1.5",
    label: "Resize from right edge",
  },
  {
    direction: "NorthWest",
    cursor: "nwse-resize",
    className: "top-0 left-0 size-3",
    label: "Resize from top left corner",
  },
  {
    direction: "NorthEast",
    cursor: "nesw-resize",
    className: "top-0 right-0 size-3",
    label: "Resize from top right corner",
  },
  {
    direction: "SouthWest",
    cursor: "nesw-resize",
    className: "bottom-0 left-0 size-3",
    label: "Resize from bottom left corner",
  },
  {
    direction: "SouthEast",
    cursor: "nwse-resize",
    className: "right-0 bottom-0 size-3",
    label: "Resize from bottom right corner",
  },
];

/**
 * Invisible edge/corner grips for the borderless window (Linux/Windows).
 *
 * A decorationless window has no OS resize border, so without these the only
 * way to resize is the window-manager key shortcut. Each grip starts a native
 * resize drag, so behavior (snapping, multi-monitor, min-size) stays with the
 * compositor instead of a JS-driven setSize loop.
 *
 * No-op on macOS: the overlay title bar keeps native resize there, and tao
 * rejects startResizeDragging on macOS anyway.
 */
export const ResizeHandles = memo(function ResizeHandles() {
  if (IS_MAC) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[100]">
      {EDGES.map((edge) => (
        <button
          key={edge.direction}
          type="button"
          tabIndex={-1}
          aria-label={edge.label}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow()
              .startResizeDragging(edge.direction)
              .catch(() => {});
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            void getCurrentWindow()
              .toggleMaximize()
              .catch(() => {});
          }}
          className={`pointer-events-auto absolute touch-none border-0 bg-transparent p-0 ${edge.className}`}
          style={{ cursor: edge.cursor }}
        />
      ))}
    </div>
  );
});
