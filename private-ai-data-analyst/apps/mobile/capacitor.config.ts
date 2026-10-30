import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.privateanalyst.mobile',
  appName: 'Private Analyst',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: {
    // We call CapacitorHttp explicitly for the Ollama connection; leave fetch/XHR unpatched.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
