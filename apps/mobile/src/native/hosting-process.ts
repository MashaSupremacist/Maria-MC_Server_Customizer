import { registerPlugin } from '@capacitor/core';

export interface HostingProcessStatus {
  state: number;
  pid: number;
  output: string;
  serverStatus: 'OFFLINE' | 'STARTING' | 'ONLINE' | 'STOPPING' | 'CRASHED';
  serverId: string;
}

export interface HostingProcessPlugin {
  startTestProcess(): Promise<{ started: boolean }>;
  startServer(options: { serverId: string }): Promise<{ started: boolean; serverId: string }>;
  sendInput(options: { input: string }): Promise<void>;
  stop(options?: { force?: boolean }): Promise<void>;
  getStatus(): Promise<HostingProcessStatus>;
}

export const HostingProcess = registerPlugin<HostingProcessPlugin>('HostingProcess');
