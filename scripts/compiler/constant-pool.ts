/** Constant pool builder — manages string and number tables */

export class ConstantPool {
  private readonly strings: string[] = [];
  private readonly stringMap = new Map<string, number>();
  private readonly numbers: number[] = [];
  private readonly numberMap = new Map<number, number>();

  addString(value: string): number {
    const existing = this.stringMap.get(value);
    if (existing !== undefined) return existing;
    const idx = this.strings.length;
    this.stringMap.set(value, idx);
    this.strings.push(value);
    return idx;
  }

  addNumber(value: number): number {
    const existing = this.numberMap.get(value);
    if (existing !== undefined) return existing;
    const idx = this.numbers.length;
    this.numberMap.set(value, idx);
    this.numbers.push(value);
    return idx;
  }

  getStrings(): string[] {
    return [...this.strings];
  }

  getNumbers(): number[] {
    return [...this.numbers];
  }
}
