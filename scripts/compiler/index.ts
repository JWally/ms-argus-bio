/** JS subset compiler — JavaScript source → BytecodeModule */

import * as acorn from 'acorn';
import type { BytecodeModule } from '../../src/vm/module';
import { CodeGenerator } from './codegen';

export function compile(source: string): BytecodeModule {
  const ast = acorn.parse(source, {
    ecmaVersion: 2022,
    sourceType: 'script',
  });

  const gen = new CodeGenerator();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gen.compileProgram((ast as any).body);

  return {
    version: 1,
    flags: 0,
    strings: gen.pool.getStrings(),
    numbers: gen.pool.getNumbers(),
    apiTable: gen.apiEntries,
    code: gen.getCode(),
  };
}
