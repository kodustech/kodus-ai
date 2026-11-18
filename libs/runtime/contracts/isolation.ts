import { z } from 'zod';

/**
 * What keeps a machine apart from its host (docs/runtime/isolation-architecture.md
 * C1, C2), in the three words the product and the hub use:
 *   - CELL_ISOLATIONS: what a cell says in its hello it runs claims under.
 *     'none' is the dev-only local-docker driver.
 *   - ISOLATION_MINIMUMS: what a claim asks at least. 'any' takes every
 *     cell; 'kernel' needs a boundary between the workload and the host
 *     kernel (gVisor or better); 'vm' needs a virtual machine (a microVM or
 *     a whole VM).
 *
 * A claim goes only to a cell whose isolation satisfies its minimum, never to
 * a lower one: a 'vm' claim with no such cell is blocked, not placed on gVisor.
 */
export const CELL_ISOLATIONS = ['vm', 'microvm', 'sandboxed-container', 'none'] as const;
export type CellIsolation = (typeof CELL_ISOLATIONS)[number];

export const ISOLATION_MINIMUMS = ['any', 'kernel', 'vm'] as const;
export const IsolationMinimumSchema = z.enum(ISOLATION_MINIMUMS);
export type IsolationMinimum = z.infer<typeof IsolationMinimumSchema>;

/** The minimum a claim asks when it names none. */
export const DEFAULT_ISOLATION_MINIMUM: IsolationMinimum = 'any';

/** The cell isolations that satisfy each minimum. */
const SATISFYING: Readonly<Record<IsolationMinimum, readonly CellIsolation[]>> = {
    any: CELL_ISOLATIONS,
    kernel: ['sandboxed-container', 'microvm', 'vm'],
    vm: ['microvm', 'vm'],
};

/** The cell isolations a claim of this minimum may run under. */
export const isolationsSatisfying = (min: IsolationMinimum = DEFAULT_ISOLATION_MINIMUM): readonly CellIsolation[] => SATISFYING[min];

/** Whether a cell that runs claims under `cell` may take a claim that asks `min`; an unknown cell isolation satisfies only 'any'. */
export function isolationSatisfies(cell: string | null | undefined, min: IsolationMinimum = DEFAULT_ISOLATION_MINIMUM): boolean {
    if (min === 'any') return true;
    return (SATISFYING[min] as readonly string[]).includes(cell ?? '');
}

/**
 * The isolation backends a cell may name in its hello capabilities: plain
 * names, not an enum, so a newer cell's backend an older hub does not know
 * passes the hello instead of refusing it.
 */
export const ISOLATION_BACKEND_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The machine architectures a cell runs (hello capabilities.arch). */
export const MACHINE_ARCHES = ['x86_64', 'arm64'] as const;
export type MachineArch = (typeof MACHINE_ARCHES)[number];

/** A minimum in words, for a blocker's message. */
export function describeIsolationMinimum(min: IsolationMinimum): string {
    switch (min) {
        case 'vm':
            return 'virtual machine (a microVM or a VM)';
        case 'kernel':
            return 'kernel (gVisor or better)';
        case 'any':
            return 'any';
    }
}
