import { execSync } from 'child_process';
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
        chunk.fileName.includes('crypto') ||
        chunk.fileName.includes('vm');
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

/** Vite plugin that compiles tripwire bytecode before build starts. */
function compileTripwirePlugin(): Plugin {
  return {
    name: 'vite-plugin-compile-tripwire',
    apply: 'build',
    buildStart() {
      try {
        execSync('npx tsx scripts/compile-tripwire.ts', {
          cwd: import.meta.dirname,
          stdio: 'inherit',
        });
      } catch (err) {
        console.error('[compile-tripwire] Failed to compile tripwire bytecode:', err);
        throw err;
      }
    },
  };
}

/** Vite plugin that injects modulepreload hints for lazy chunks that are always needed. */
function preloadLazyChunksPlugin(): Plugin {
  return {
    name: 'vite-plugin-preload-lazy',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html;
      const tags: { tag: string; attrs: Record<string, string>; injectTo: 'head' }[] = [];
      for (const [fileName] of Object.entries(ctx.bundle)) {
        if (fileName.includes('CaptchaPage') && fileName.endsWith('.js')) {
          tags.push({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: '', href: `/${fileName}` },
            injectTo: 'head',
          });
        }
        if (fileName.includes('CaptchaPage') && fileName.endsWith('.css')) {
          tags.push({
            tag: 'link',
            attrs: { rel: 'preload', as: 'style', crossorigin: '', href: `/${fileName}` },
            injectTo: 'head',
          });
        }
        if (fileName.includes('pako') && fileName.endsWith('.js')) {
          tags.push({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: '', href: `/${fileName}` },
            injectTo: 'head',
          });
        }
        if (fileName.includes('crypto.worker') && fileName.endsWith('.js')) {
          tags.push({
            tag: 'link',
            attrs: { rel: 'preload', as: 'script', crossorigin: '', href: `/${fileName}` },
            injectTo: 'head',
          });
        }
      }
      return tags;
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), compileTripwirePlugin(), preloadLazyChunksPlugin(), obfuscatorPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler'))
              return 'vendor';
            if (id.includes('pako')) return 'pako';
          }
        },
      },
    },
  },
});
