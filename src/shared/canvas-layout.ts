import type { CanvasPosition, TaskWorkspace } from "./models";

export interface NodeSize { width: number; height: number }
export interface LayoutBox extends NodeSize { id: string; column: number; position: CanvasPosition }
export type MeasuredSizes = ReadonlyMap<string, Partial<NodeSize>>;
const WIDTH = 240, ROW_GAP = 60, COLUMN_GAP = 120;
const columnX = [80, 440, 820, 1180, 1560, 1940];

function size(id: string, height: number, measured?: MeasuredSizes): NodeSize {
  const value = measured?.get(id);
  const finite = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) && value > 0 && value <= 1000000 ? Math.max(fallback, value) : fallback;
  return { width: finite(value?.width, WIDTH), height: finite(value?.height, height) };
}
function definitions(workspace: TaskWorkspace, measured?: MeasuredSizes): LayoutBox[] {
  const node = (id: string, column: number, height: number, position: CanvasPosition): LayoutBox => ({ id, column, position, ...size(id, height, measured) });
  const production = (id: string, column: number, height: number, index: number) => node(id, column, height,
    workspace.productionPositions?.[id] ?? { x: columnX[column]!, y: 80 + index * (height + ROW_GAP) });
  return [node("script", 0, 360, workspace.scriptPosition),
    ...workspace.shots.map(shot => node(shot.id, 1, 430, shot.position)),
    ...workspace.assets.map(asset => node(asset.id, 2, 360, asset.position)),
    ...workspace.shots.map((shot, index) => production(`prompt:shot:${shot.id}`, 3, 400, index)),
    ...["video", "firstFrame", "lastFrame"].map((kind, index) => production(`prompt:${kind}`, 4, 400, index)),
    ...["first", "last"].map((slot, index) => production(`frame:${slot}`, 5, 330, index))];
}
export function boxesOverlap(a: LayoutBox, b: LayoutBox, gap = 0): boolean {
  return a.position.x < b.position.x + b.width + gap && a.position.x + a.width + gap > b.position.x
    && a.position.y < b.position.y + b.height + gap && a.position.y + a.height + gap > b.position.y;
}
function vacant(box: LayoutBox, occupied: LayoutBox[]): LayoutBox {
  let next = box;
  // Only move new nodes downward; each jump clears at least one obstacle.
  for (let attempt = 0; attempt <= occupied.length; attempt++) {
    const collisions = occupied.filter(other => boxesOverlap(next, other, ROW_GAP));
    if (!collisions.length) return next;
    const y = Math.max(...collisions.map(other => other.position.y + other.height + ROW_GAP));
    if (!Number.isSafeInteger(Math.ceil(y)) || y <= next.position.y) break;
    next = { ...next, position: { x: next.position.x, y } };
  }
  // Corrupt/extreme historical coordinates must never spin or create Infinity.
  const right = occupied.map(other => other.position.x + other.width + COLUMN_GAP).filter(x => Number.isFinite(x) && Math.abs(x) < 1e9);
  return { ...box, position: { x: Math.max(80, ...right), y: 80 } };
}

/** Legacy missing positions get collision-free defaults; saved manual coordinates never move. */
export function resolvedProductionPositions(workspace: TaskWorkspace, measured?: MeasuredSizes): Record<string, CanvasPosition> {
  const all = definitions(workspace, measured);
  const existing = all.filter(box => box.column < 3 || workspace.productionPositions?.[box.id]);
  const positions: Record<string, CanvasPosition> = {};
  for (const box of all.filter(box => box.column >= 3)) {
    const placed = workspace.productionPositions?.[box.id] ? box : vacant(box, existing);
    positions[box.id] = placed.position;
    if (!workspace.productionPositions?.[box.id]) existing.push(placed);
  }
  return positions;
}
export function canvasBoxes(workspace: TaskWorkspace, measured?: MeasuredSizes): LayoutBox[] {
  const positions = resolvedProductionPositions(workspace, measured);
  return definitions(workspace, measured).map(box => box.column >= 3 ? { ...box, position: positions[box.id]! } : box);
}
function applyPositions(workspace: TaskWorkspace, positions: Map<string, CanvasPosition>): TaskWorkspace {
  return { ...workspace, scriptPosition: positions.get("script") ?? workspace.scriptPosition,
    shots: workspace.shots.map(shot => ({ ...shot, position: positions.get(shot.id) ?? shot.position })),
    assets: workspace.assets.map(asset => ({ ...asset, position: positions.get(asset.id) ?? asset.position })),
    productionPositions: Object.fromEntries(definitions(workspace).filter(box => box.column >= 3)
      .map(box => [box.id, positions.get(box.id) ?? box.position])) };
}

/** User-triggered full layout: narrative order is untouched; only view coordinates change. */
export function arrangeCanvas(workspace: TaskWorkspace, measured?: MeasuredSizes): TaskWorkspace {
  const all = definitions(workspace, measured), positions = new Map<string, CanvasPosition>();
  let x = 80;
  for (let column = 0; column < 6; column++) {
    const nodes = all.filter(box => box.column === column);
    let y = 80;
    for (const box of nodes) { positions.set(box.id, { x, y }); y += box.height + ROW_GAP; }
    x += Math.max(WIDTH, ...nodes.map(box => box.width)) + COLUMN_GAP;
  }
  return applyPositions(workspace, positions);
}

/** Place additions only, preserving all pre-existing manual and derived positions. */
export function placeAddedNodes(previous: TaskWorkspace, next: TaskWorkspace, measured?: MeasuredSizes): TaskWorkspace {
  if (next === previous) return next;
  const occupied = canvasBoxes(previous, measured);
  const oldIds = new Set(occupied.map(box => box.id));
  const positions = new Map(occupied.map(box => [box.id, box.position]));
  for (const box of definitions(next, measured).filter(box => !oldIds.has(box.id))) {
    const placed = vacant(box, occupied); occupied.push(placed); positions.set(box.id, placed.position);
  }
  return applyPositions(next, positions);
}

/** Materialize old defaults on first edit, so reordering cannot move unpositioned nodes. */
export function preserveProductionPositions(previous: TaskWorkspace, next: TaskWorkspace): TaskWorkspace {
  const old = resolvedProductionPositions(previous), defaults = resolvedProductionPositions(next);
  return { ...next, productionPositions: Object.fromEntries(Object.keys(defaults)
    .map(id => [id, next.productionPositions?.[id] ?? old[id] ?? defaults[id]!])) };
}
