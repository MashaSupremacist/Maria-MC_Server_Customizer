import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const JAVA_RUNTIME_MAJORS = [8, 17, 21, 25] as const;
export type JavaRuntimeMajor = (typeof JAVA_RUNTIME_MAJORS)[number];

export interface InstalledJavaRuntime {
  majorVersion: number;
  architecture: string;
  installPath: string;
  javaPath: string;
  version: string;
  versionOutput: string;
  checksum: string;
  installedAt: string;
}

export interface JavaRuntimeInfo {
  architecture: string;
  root: string;
  supportedMajors: number[];
  installed: InstalledJavaRuntime[];
}

export interface JavaRuntimeProgress {
  majorVersion: number;
  status: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'checking' | 'complete' | 'failed';
  percent: number | null;
  message: string;
}

export interface JavaRuntimeResult {
  runtime: InstalledJavaRuntime;
}

export interface JavaRuntimeVerification {
  majorVersion: number;
  installed: boolean;
  javaPath: string;
  version: string;
  output: string;
}

export interface JavaRuntimePlugin {
  getRuntimeInfo(): Promise<JavaRuntimeInfo>;
  downloadRuntime(options: { majorVersion: JavaRuntimeMajor }): Promise<JavaRuntimeResult>;
  verifyRuntime(options: { majorVersion: JavaRuntimeMajor }): Promise<JavaRuntimeVerification>;
  addListener(
    eventName: 'runtimeProgress',
    listenerFunc: (progress: JavaRuntimeProgress) => void,
  ): Promise<PluginListenerHandle>;
}

export const JavaRuntime = registerPlugin<JavaRuntimePlugin>('JavaRuntime');
