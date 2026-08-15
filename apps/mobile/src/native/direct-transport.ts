import { registerPlugin } from '@capacitor/core';

export type DirectTransportState = 'IDLE' | 'STARTING' | 'CONNECTING' | 'RUNNING' | 'RECONNECTING' | 'COMPLETE' | 'FAILED' | 'STOPPED';

export interface DirectTransportStatus {
  status: DirectTransportState;
  active: boolean;
  transport: 'tls-tcp';
  host: string;
  port: number;
  message: string;
  startedAt: number;
  updatedAt: number;
  completedAt: number;
  probes: number;
  reconnects: number;
  bytesSent: number;
  bytesReceived: number;
  lastRttMs: number;
  tlsProtocol: string;
  certificateFingerprint: string;
}

export interface DirectTransportOptions {
  host: string;
  port: number;
  token: string;
  certificateFingerprint: string;
  durationSeconds: number;
  payloadBytes?: number;
}

export interface DirectTransportPlugin {
  startTest(options: DirectTransportOptions): Promise<DirectTransportStatus>;
  stopTest(): Promise<void>;
  getStatus(): Promise<DirectTransportStatus>;
}

export const DirectTransport = registerPlugin<DirectTransportPlugin>('DirectTransport');
