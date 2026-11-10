import { z } from 'zod';

/**
 * A machine size: the memory (MB) and whole CPUs every build and service of
 * a claim's workload gets. The environment's setting chooses one of the
 * presets (absent: the cell's default size); the hub sends it in
 * claim.acquire, and the cell refuses a size above the largest it grants
 * (blocker resources/size_unavailable). The bounds only keep the numbers
 * sane: what a claim can get is the cell's own maximum.
 */
export const MACHINE_SIZE_LIMITS = {
    memoryMb: { min: 512, max: 262_144 },
    cpus: { min: 1, max: 64 },
} as const;

export const MachineSizeSchema = z.strictObject({
    memoryMb: z.number().int().min(MACHINE_SIZE_LIMITS.memoryMb.min).max(MACHINE_SIZE_LIMITS.memoryMb.max),
    cpus: z.number().int().min(MACHINE_SIZE_LIMITS.cpus.min).max(MACHINE_SIZE_LIMITS.cpus.max),
});

export type MachineSize = z.infer<typeof MachineSizeSchema>;

/** The sizes an environment can choose; none chosen is the cell's default. */
export const MACHINE_SIZE_PRESETS = ['small', 'medium', 'large'] as const;
export type MachineSizePreset = (typeof MACHINE_SIZE_PRESETS)[number];

export const MACHINE_SIZES: Readonly<Record<MachineSizePreset, MachineSize>> = {
    small: { memoryMb: 4_096, cpus: 2 },
    medium: { memoryMb: 8_192, cpus: 4 },
    large: { memoryMb: 16_384, cpus: 8 },
};

export const isMachineSizePreset = (v: unknown): v is MachineSizePreset => typeof v === 'string' && (MACHINE_SIZE_PRESETS as readonly string[]).includes(v);

/** The size a preset asks for; none (null or absent) asks none, so the cell's default applies. */
export function machineSizeOf(preset: MachineSizePreset | null | undefined): MachineSize | undefined {
    return preset ? { ...MACHINE_SIZES[preset] } : undefined;
}

/** A size fits a maximum when neither its memory nor its CPUs are above it. */
export const fitsWithin = (size: MachineSize, max: MachineSize): boolean => size.memoryMb <= max.memoryMb && size.cpus <= max.cpus;

/** A size as the cell names it in its refusals (driver.ClaimSize.String): "16384 MB / 8 CPUs". */
export const describeMachineSize = (s: MachineSize): string => `${s.memoryMb} MB / ${s.cpus} CPUs`;
