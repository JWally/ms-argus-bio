import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { obfuscator } from 'rollup-obfuscator';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === 'production'
      ? [
          obfuscator({
            include: ['src/**/*.ts', 'src/**/*.tsx'],
            exclude: ['node_modules/**'],
            options: {
              stringEncryption: true,
              controlFlowFlattening: true,
              controlFlowFlatteningThreshold: 0.5,
              deadCodeInjection: true,
              deadCodeInjectionThreshold: 0.2,
              selfDefending: true,
              identifierNamesGenerator: 'hexadecimal',
              stringArrayThreshold: 0.5,
              transformObjectKeys: false,
              unicodeEscapeSequence: false,
            },
          }),
        ]
      : []),
  ],
}));
