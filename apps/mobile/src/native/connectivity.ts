import { registerPlugin } from '@capacitor/core';

export interface ConnectivityStatus {
  localIp: string | null;
  serverPort: number;
  lanAddress: string | null;
  networkConnected: boolean;
  wifiConnected: boolean;
  networkType: 'wifi' | 'ethernet' | 'other' | 'offline';
  portAvailable: boolean;
  portConflict: boolean;
  serverId: string;
}

export interface ConnectivityPlugin {
  getStatus(options?: { serverId?: string; port?: number }): Promise<ConnectivityStatus>;
}

export const Connectivity = registerPlugin<ConnectivityPlugin>('Connectivity');
