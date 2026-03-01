/** Linear scan register allocator */

const REG_GP_START = 8;
const REG_GP_END = 55;

export class RegisterAllocator {
  private readonly used = new Set<number>();
  private nextReg = REG_GP_START;

  alloc(): number {
    while (this.used.has(this.nextReg) && this.nextReg <= REG_GP_END) {
      this.nextReg++;
    }
    if (this.nextReg > REG_GP_END) {
      throw new Error('Register exhaustion: all 48 GP registers in use');
    }
    const reg = this.nextReg;
    this.used.add(reg);
    this.nextReg++;
    return reg;
  }

  free(reg: number): void {
    this.used.delete(reg);
    if (reg < this.nextReg) {
      this.nextReg = reg;
    }
  }

  reserve(reg: number): void {
    this.used.add(reg);
  }

  isUsed(reg: number): boolean {
    return this.used.has(reg);
  }
}
