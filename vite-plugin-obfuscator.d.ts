declare module 'rollup-obfuscator' {
  import type { Plugin } from 'vite';

  interface ObfuscatorOptions {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    options?: Record<string, unknown>;
  }

  export function obfuscator(options?: ObfuscatorOptions): Plugin;
}
