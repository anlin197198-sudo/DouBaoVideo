import type { TaskWorkspace } from "./models";
type Viewport = TaskWorkspace["viewport"];
export interface FocusTarget { position: { x: number; y: number }; width: number; height: number }
/** Event-only viewport calculation. Never changes zoom or any node/content data.
 * Null means no movement: missing/invalid target, zero-size host, or already visible. */
export function viewportForTarget(viewport: Viewport, host: { width: number; height: number }, target: FocusTarget | null | undefined): Viewport | null {
  if (!target || ![viewport.x, viewport.y, viewport.zoom, host.width, host.height, target.position.x, target.position.y, target.width, target.height].every(Number.isFinite)
    || viewport.zoom <= 0 || host.width <= 0 || host.height <= 0 || target.width <= 0 || target.height <= 0) return null;
  const left = target.position.x * viewport.zoom + viewport.x, top = target.position.y * viewport.zoom + viewport.y;
  const width = target.width * viewport.zoom, height = target.height * viewport.zoom;
  if (left >= 0 && top >= 0 && left + width <= host.width && top + height <= host.height) return null;
  const next = { x: host.width / 2 - (target.position.x + target.width / 2) * viewport.zoom,
    y: host.height / 2 - (target.position.y + target.height / 2) * viewport.zoom, zoom: viewport.zoom };
  if (![next.x, next.y].every(Number.isFinite) || (next.x === viewport.x && next.y === viewport.y)) return null;
  return next;
}
