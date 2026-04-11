import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.strydervalehouse.haven',
  appName: 'Haven',
  webDir: 'dist',
  server: {
    url: 'https://haven-kb6.pages.dev',
    allowNavigation: ['*.supabase.co', '*.workers.dev', '*.example.workers.dev', 'haven-kb6.pages.dev'],
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
