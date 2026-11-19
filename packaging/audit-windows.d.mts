export function assertWindowsX64(path: string, kind: "application" | "library"): void;
export function auditWindowsDirectory(directory: string, freshOut: string): { bundles: number; nativeLibraries: number };
