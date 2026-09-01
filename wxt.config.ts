import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  publicDir: 'src/public',
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    version: '0.3.1',
    default_locale: 'zh_CN',
    permissions: ['tts', 'storage', 'activeTab', 'offscreen'],
    host_permissions: [
      'https://*.bing.com/*',
      'https://translate.googleapis.com/*',
    ],
    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
});