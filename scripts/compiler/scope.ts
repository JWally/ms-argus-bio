/** Variable scope tracking for the compiler */

export interface Variable {
  name: string;
  register: number;
  kind: 'const' | 'let' | 'var' | 'param';
}

export class Scope {
  private readonly variables = new Map<string, Variable>();
  private readonly parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  define(name: string, register: number, kind: Variable['kind']): void {
    this.variables.set(name, { name, register, kind });
  }

  lookup(name: string): Variable | undefined {
    const local = this.variables.get(name);
    if (local) return local;
    return this.parent?.lookup(name);
  }

  hasRegister(reg: number): boolean {
    for (const v of this.variables.values()) {
      if (v.register === reg) return true;
    }
    return this.parent?.hasRegister(reg) ?? false;
  }

  child(): Scope {
    return new Scope(this);
  }
}
