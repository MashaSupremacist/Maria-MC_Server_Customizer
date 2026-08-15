import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.msc.minecraftservercustomizer',
  appName: 'Minecraft Server Customizer',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
