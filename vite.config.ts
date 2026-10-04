import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split vendor libs into separate chunks
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Split heavy pages into async chunks
          'pages-utils': [
            './src/pages/utilities',
            './src/pages/finance',
          ],
          'pages-payments': [
            './src/pages/payments',
            './src/pages/addstudent',
            './src/pages/editprofile',
          ],
          'pages-media': [
            './src/pages/media',
            './src/pages/videos',
            './src/pages/library',
          ],
          'pages-nets': [
            './src/pages/nets_hub',
            './src/pages/nets_admin',
            './src/pages/nets_staff',
            './src/pages/nets_calendar',
          ],
          'pages-misc': [
            './src/pages/matches',
            './src/pages/remarks',
            './src/pages/records',
            './src/pages/pulse',
          ],
        },
      },
    },
    // Enable minification
    minify: 'esbuild',
  },
  optimizeDeps: {
    include: ['sql.js'],
  },
});
