import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
const inputSchema = z.object({ taskId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
/** Main-only observation, NOT a reservation, write authorization or media verification.
 * A single SELECT observes the actual task revision and film versions consistently.
 * Any future writer must repeat these checks and reserve atomically in its own transaction. */
export function preflightFilmVersion(database: DatabaseSync, raw: unknown) {
  let input: ReturnType<typeof inputSchema.safeParse>;
  try { input = inputSchema.safeParse(raw); } catch { throw new Error("成片版本预检查参数无效。"); }
  if (!input.success) throw new Error("成片版本预检查参数无效。");
  const { taskId, expectedRevision } = input.data;
  let row: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>;
  try { row = database.prepare(`SELECT t.revision,
    COUNT(f.task_id) AS film_count, COUNT(DISTINCT f.version) AS distinct_versions,
    COALESCE(MAX(f.version),0) AS maximum_version,
    SUM(CASE WHEN f.task_id IS NOT NULL AND (f.id IS NULL OR typeof(f.version)!='integer' OR f.version<1 OR f.version>?
      OR e.id IS NULL OR e.task_id!=t.id) THEN 1 ELSE 0 END) AS anomalies
    FROM tasks t LEFT JOIN films f ON f.task_id=t.id LEFT JOIN executions e ON e.id=f.execution_id
    WHERE t.id=? GROUP BY t.id`).get(Number.MAX_SAFE_INTEGER, taskId); } catch { throw new Error("无法安全读取成片版本记录，请核对数据库。"); }
  if (!row) throw new Error("任务不存在，无法预检查成片版本。");
  if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0)
    throw new Error("任务修订记录异常，需先核对。");
  if (row.revision !== expectedRevision) throw new Error("任务修订已变化，请重新预检查。");
  if (row.anomalies !== 0 || row.film_count !== row.distinct_versions
    || typeof row.maximum_version !== "number" || !Number.isSafeInteger(row.maximum_version) || row.maximum_version < 0)
    throw new Error("成片版本或任务归属记录异常，需先核对。");
  if (row.maximum_version >= Number.MAX_SAFE_INTEGER) throw new Error("成片版本已达到安全整数上限。");
  return Object.freeze({ taskId, observedRevision: row.revision, proposedVersion: row.maximum_version + 1,
    reserved: false as const, writeAuthorized: false as const, mediaVerified: false as const });
}
