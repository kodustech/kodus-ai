export function ran(a: number): number {
  return a + 1;
}

export function never(b: number): number {
  const c: number = b * 2;
  return c;
}

ran(1);
