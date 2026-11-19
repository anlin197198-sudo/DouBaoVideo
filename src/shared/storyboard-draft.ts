import type { StoryboardShot, TaskWorkspace } from "./models";
import { MAX_SHOTS } from "./storyboard";
import type { ShotContent } from "./storyboard-candidate";
import type { SaveState } from "./workspace-autosave";

export type StoryboardPrefix = ReadonlyArray<Readonly<{ id: string } & ShotContent>>;

export function storyboardPrefix(shots: readonly StoryboardShot[]): StoryboardPrefix {
  return shots.map(({ id, title, description, action, shotSize, cameraMovement, audio }) =>
    ({ id, title, description, action, shotSize, cameraMovement, audio }));
}

export function matchesStoryboardPrefix(shots: readonly StoryboardShot[], prefix: StoryboardPrefix): boolean {
  return shots.length === prefix.length && prefix.every((p, i) => {
    const s = shots[i]!;
    return s.id === p.id && s.title === p.title && s.description === p.description &&
      s.action === p.action && s.shotSize === p.shotSize && s.cameraMovement === p.cameraMovement && s.audio === p.audio;
  });
}

/** Append only; an approved candidate must never replace manual shots, references or edits. */
export function appendStoryboardDraft(
  local: { taskId: string; revision: number; workspace: TaskWorkspace; state: SaveState },
  approved: { taskId: string; revision: number; prefix: StoryboardPrefix; shots: StoryboardShot[] },
): TaskWorkspace | null {
  const { state, workspace } = local;
  if (approved.taskId !== local.taskId || approved.revision !== local.revision || state.dirty ||
      state.saving || state.conflict || state.error || !workspace.script.trim() ||
      !matchesStoryboardPrefix(workspace.shots, approved.prefix) || !approved.shots.length ||
      workspace.shots.length + approved.shots.length > MAX_SHOTS) return null;
  const ids = new Set(workspace.shots.map(shot => shot.id));
  for (const shot of approved.shots) {
    if (ids.has(shot.id)) return null;
    ids.add(shot.id);
  }
  return { ...workspace, shots: [...workspace.shots, ...approved.shots] };
}
