type SmokeOptions = { exe: string; parent: string };
type FileSystem = {
  lstat(path: string): { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean };
  realpath(path: string): string;
  mkdir(path: string): unknown;
  mkdtemp(prefix: string): string;
  assertExecutable(path: string): void;
};
type Plan = { root: string; exe: string; cwd: string; env: Record<string, string> };
type Child = { pid: number | undefined; once(event: string, listener: (...args: any[]) => void): unknown; unref(): unknown };
export function isLiteralDrivePath(value: unknown): boolean;
export function parseSmokeOptions(argv: string[]): SmokeOptions | null;
export function prepareWindowsSmoke(options: SmokeOptions, systemRoot: string, fs?: FileSystem): Plan;
export function observeOwnedLaunch(plan: Plan, options?: {
  start?: (exe: string, args: string[], options: { cwd: string; env: Record<string, string>; shell: false; stdio: 'ignore' }) => Child;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  onSpawn?: (pid: number | undefined) => void;
  onDeadline?: (pid: number | undefined) => void;
}): Promise<{ state: 'launch_failed' | 'launch_not_observed' | 'observation_failed' | 'exited' | 'exit_not_observed'; code?: number | null; signal?: string | null }>;
