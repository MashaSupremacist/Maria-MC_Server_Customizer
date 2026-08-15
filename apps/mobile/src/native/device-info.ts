import { registerPlugin } from '@capacitor/core';

export interface NativeDeviceInfo {
  androidVersion: string;
  sdkInt: number;
  architecture: string;
  manufacturer: string;
  model: string;
}

export interface NativeMemoryInfo {
  totalBytes: number;
  availableBytes: number;
  lowMemory: boolean;
}

export interface NativeStorageInfo {
  totalBytes: number;
  availableBytes: number;
}

export interface NativeSafetyInfo {
  batteryPercent: number;
  charging: boolean;
  thermalStatusCode: number;
  thermalStatus: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  lowMemory: boolean;
  totalStorageBytes: number;
  availableStorageBytes: number;
}

export interface NativeAppDataDirectory {
  path: string;
  serverDirectory: string;
}

export interface DeviceInfoPlugin {
  getDeviceInfo(): Promise<NativeDeviceInfo>;
  getMemoryInfo(): Promise<NativeMemoryInfo>;
  getStorageInfo(): Promise<NativeStorageInfo>;
  getSafetyInfo(): Promise<NativeSafetyInfo>;
  getAppDataDirectory(): Promise<NativeAppDataDirectory>;
}

export const DeviceInfo = registerPlugin<DeviceInfoPlugin>('DeviceInfo');
