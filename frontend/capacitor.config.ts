import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.strydervalehouse.haven',
  appName: 'Haven',
  webDir: 'dist',
  server: {
    allowNavigation: ['*.workers.dev', '*.pages.dev'],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
