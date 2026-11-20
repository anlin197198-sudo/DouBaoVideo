import { randomUUID } from "node:crypto";
import { lstat, realpath, open, link, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

type Status = "supported" | "unsupported" | "stale" | "failed" | "cleanup-unconfirmed";
type Identity = Readonly<{ dev: bigint; ino: bigint }>;
type Owned = { path: string; identity?: Identity; created: boolean };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const usable = (v: Identity) => v.dev >= 0n && v.ino > 0n;
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const unsupported = (error: unknown) => ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes(code(error) ?? "");
const readStat = (path: string) => lstat(path, { bigint: true });
const statOrAbsent = async (path: string) => {
  try { return await readStat(path); } catch (error) { if (code(error) === "ENOENT") return null; throw error; }
};

/** Trusted private local directory. No effects outside its two synthetic names. No publication claim.
 * No same-user adversarial replacement guarantee between path-based filesystem operations. */
export async function preflightArchiveDirectory(
  directory: string,
  isCurrent: () => boolean,
  io: { link?: typeof link; unlink?: typeof unlink } = {},
): Promise<Status> {
  let status: Status = "failed", parent: Identity | undefined, attemptedVacantLink = false;
  const prefix = join(directory, `.doubao-archive-check-${randomUUID()}`);
  const a: Owned = { path: prefix + "-a", created: false }, b: Owned = { path: prefix + "-b", created: false };
  const bytesA = Buffer.from("doubao archive check A\n"), bytesB = Buffer.from("doubao archive check B\n");
  const guard = async () => {
    const candidate = await readStat(directory);
    if (!parent || !candidate.isDirectory() || !same(candidate, parent) || await realpath(directory) !== directory) throw new Error();
  };
  async function create(slot: Owned, bytes: Buffer) {
    await guard();
    const fd = await open(slot.path, "wx", 0o600);
    slot.created = true;
    try {
      const stat = await fd.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || !usable(stat)) throw new Error();
      slot.identity = stat;
      await fd.writeFile(bytes);
      await fd.sync();
    } finally { await fd.close(); }
  }
  async function verify(path: string, expected: Identity, bytes: Buffer, links: bigint) {
    await guard();
    const verifyStat = (stat: Awaited<ReturnType<typeof readStat>>) =>
      stat.isFile() && same(stat, expected) && stat.nlink === links && stat.size === BigInt(bytes.length);
    if (!verifyStat(await readStat(path))) throw new Error();
    const fd = await open(path, "r");
    try {
      if (!verifyStat(await fd.stat({ bigint: true }))) throw new Error();
      const buffer = Buffer.alloc(bytes.length + 1);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== bytes.length || !buffer.subarray(0, bytesRead).equals(bytes) ||
        !verifyStat(await fd.stat({ bigint: true })) || !verifyStat(await readStat(path))) throw new Error();
    } finally { await fd.close(); }
  }
  async function removeOwned(slot: Owned, possibleLink?: Identity) {
    if (!slot.created && !possibleLink) return;
    await guard();
    const actual = await statOrAbsent(slot.path);
    if (!actual) return;
    if (!actual.isFile() || !usable(actual) ||
      !(slot.identity && same(actual, slot.identity) || possibleLink && same(actual, possibleLink))) throw new Error();
    await (io.unlink ?? unlink)(slot.path);
    if (await statOrAbsent(slot.path)) throw new Error();
  }
  try {
    if (!isAbsolute(directory) || resolve(directory) !== directory || parse(directory).root === directory) return "failed";
    const stat = await readStat(directory);
    if (!stat.isDirectory() || !usable(stat) || await realpath(directory) !== directory) return "failed";
    parent = stat;
    if (!isCurrent()) return "stale";
    await create(a, bytesA);
    if (!isCurrent()) { status = "stale"; } else {
      await create(b, bytesB);
      await verify(a.path, a.identity!, bytesA, 1n);
      await verify(b.path, b.identity!, bytesB, 1n);
      if (!isCurrent()) { status = "stale"; } else {
        let occupiedError: unknown;
        try { await (io.link ?? link)(a.path, b.path); } catch (error) { occupiedError = error; }
        await verify(a.path, a.identity!, bytesA, 1n);
        await verify(b.path, b.identity!, bytesB, 1n);
        if (unsupported(occupiedError)) { status = "unsupported"; }
        else if (code(occupiedError) === "EEXIST") {
          await removeOwned(b);
          b.created = false;
          b.identity = undefined;
          if (!isCurrent()) { status = "stale"; } else {
            await guard();
            if (await statOrAbsent(b.path)) throw new Error();
            attemptedVacantLink = true;
            try {
              await (io.link ?? link)(a.path, b.path);
              await verify(a.path, a.identity!, bytesA, 2n);
              await verify(b.path, a.identity!, bytesA, 2n);
              status = "supported";
            } catch (error) {
              // An error with a possible link is not evidence of support or of absence.
              status = unsupported(error) && !await statOrAbsent(b.path) ? "unsupported" : "failed";
            }
          }
        }
      }
    }
  } catch { status = "failed"; }
  let cleaned = true;
  try { await removeOwned(b, attemptedVacantLink ? a.identity : undefined); } catch { cleaned = false; }
  try { await removeOwned(a); } catch { cleaned = false; }
  if (!cleaned) return "cleanup-unconfirmed";
  try { return isCurrent() ? status : "stale"; } catch { return "stale"; }
}
