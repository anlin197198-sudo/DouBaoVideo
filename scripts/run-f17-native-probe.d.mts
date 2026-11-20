export function acceptsNativeProbeLaunch(argv: string[], platform: string): boolean;
export function nativeProbeEnvironment(systemRoot: string, privateRoot: string): Record<string,string>;
export type NativeProbeMode="probe"|"full-import";
export type NativeProbeReport={stage:string;result:string;width?:number;height?:number;taskUnchanged?:true;archiveVerified?:true;metadataRecorded?:true};
export function classifyNativeProbeOutput(line: string,mode?:NativeProbeMode): NativeProbeReport|null;
export function runNativeProbe(argv?:string[]):Promise<number>;

export function classifyNativeProbeExit(report:unknown, exitCode:number|null,mode?:NativeProbeMode):NativeProbeReport;
