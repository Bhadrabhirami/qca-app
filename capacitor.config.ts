import { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId:   'com.xxgs.qca_app',
  appName: 'Quickies Cricket',
  webDir:  'dist',
  server: {
    androidScheme: 'http',
    allowNavigation: ['145.241.114.13', 'localhost', '127.0.0.1', '192.168.1.189', '10.0.2.2'],
  },
  android: {
    allowMixedContent:           true,
    // webContentsDebuggingEnabled left unset: Capacitor enables WebView
    // inspection for debug builds only, never for signed release APKs.
    backgroundColor:             '#001f3f',
  },
};
export default config;
