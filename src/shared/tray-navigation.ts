/** Tray requests never navigate automatically. Explicit UI adoption must not unmount an editor. */
export function canOpenTrayQueue(state: { hasCanvas: boolean; hasDialog: boolean; busy: boolean; ready: boolean }): boolean {
  return state.ready && !state.hasCanvas && !state.hasDialog && !state.busy;
}
