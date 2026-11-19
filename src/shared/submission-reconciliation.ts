import { resolveSubmissionResult } from "./submission-result";
export const MAX_SUBMISSION_OBSERVATIONS = 100;
/** Pure internal full-list evaluation, not an authenticated protocol adapter or durable ledger.
 * Callers must retain the complete evidence list. Removing observations can remove conflicts;
 * this function cannot enforce persistence, authenticity or cross-process history completeness.
 * No outcome permits automatic retry or claims a generated/completed video. */
export function reconcileSubmissionResults(rawAttempt: unknown, rawObservations: unknown) {
  const initial = resolveSubmissionResult(rawAttempt, null);
  if (initial.status === "invalid-attempt") return initial;
  const attempt = initial.attempt;
  const invalidList = () => Object.freeze({ status: "requires-human-check" as const, reason: "INVALID_OR_OVERSIZED_OBSERVATION_LIST" as const,
    attempt, evaluated: false as const, unconditionalRetry: false as const, videoCompleted: false as const });
  let observations: unknown[];
  try {
    if (!Array.isArray(rawObservations)) return invalidList();
    const length = rawObservations.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SUBMISSION_OBSERVATIONS) return invalidList();
    // Admit only actual array slots, never invoke array accessors or a caller iterator.
    observations = [];
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(rawObservations, String(i));
      if (!descriptor || !("value" in descriptor)) return invalidList();
      observations.push(descriptor.value);
    }
  } catch { return invalidList(); }
  const refs = new Set<string>(); let declined = false, unverified = 0;
  for (const evidence of observations) {
    const result = resolveSubmissionResult(attempt, evidence);
    if (result.status === "remote-acknowledged") refs.add(result.remoteTaskId);
    else if (result.status === "declined-no-remote-task") declined = true;
    else unverified++;
  }
  const acceptedReferences = Object.freeze([...refs].sort());
  const shared = { attempt, evaluated: true as const, acceptedReferences, unverifiedObservations: unverified,
    unconditionalRetry: false as const, videoCompleted: false as const };
  if (refs.size > 1 || (refs.size > 0 && declined)) return Object.freeze({ ...shared,
    status: "requires-human-check" as const, reason: "CONTRADICTORY_VERIFIED_OBSERVATIONS" as const });
  if (refs.size === 1) return Object.freeze({ ...shared, status: "remote-acknowledged" as const });
  if (declined && !unverified) return Object.freeze({ ...shared, status: "declined-no-remote-task" as const });
  return Object.freeze({ ...shared, status: "requires-check" as const, reason: "NO_UNAMBIGUOUS_VERIFIED_OUTCOME" as const });
}
