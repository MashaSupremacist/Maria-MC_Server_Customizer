import { registerPlugin } from '@capacitor/core';

export interface PlayitResearchCapabilities {
  status: 'research-only';
  release: string;
  abi: string;
  asset: string | null;
  downloadUrl: string | null;
  architectureSupported: boolean;
  executionMode: 'app-private-process';
  defaultPathsCompatible: boolean;
  secretRequired: boolean;
  agentPrepared: boolean;
  integrationReady: boolean;
  message: string;
}

export interface PlayitResearchPlugin {
  getCapabilities(): Promise<PlayitResearchCapabilities>;
}

export const PlayitResearch = registerPlugin<PlayitResearchPlugin>('PlayitResearch');
