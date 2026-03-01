import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import JavaScriptObfuscator from 'javascript-obfuscator';

/** Vite plugin that obfuscates app chunks but skips vendor/library chunks. */
function obfuscatorPlugin(): Plugin {
  return {
    name: 'vite-plugin-obfuscate',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (!chunk.fileName.endsWith('.js')) return null;

      // Only obfuscate page/feature chunks — skip entry (has dynamic imports
      // that get corrupted by stringArray) and vendor (open-source libraries)
      const isPageChunk =
        chunk.fileName.includes('CaptchaPage') ||
        chunk.fileName.includes('TicTacToePage') ||
        chunk.fileName.includes('crypto');
      if (!isPageChunk) return null;

      const result = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        stringArray: true,
        stringArrayThreshold: 1,
        stringArrayEncoding: ['base64'],
        stringArrayRotate: true,
        stringArrayShuffle: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        identifierNamesGenerator: 'hexadecimal',
        selfDefending: false,
        transformObjectKeys: false,
        unicodeEscapeSequence: false,
      });
      return { code: result.getObfuscatedCode(), map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), obfuscatorPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
});
