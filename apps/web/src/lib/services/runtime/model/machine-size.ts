import type { MachineSize, MachineSizePreset } from "../contracts";

// The memory and CPUs every build and service of an environment gets. The
// cell's default suits most apps; a heavy compiled build (a large Go, Rust or
// TypeScript monorepo) is killed at it and needs a larger size. The values
// mirror libs/runtime/contracts/machine-size.ts (MACHINE_SIZES), checked by
// machine-size.parity.spec.ts: the web build takes no values from the libs.

/** A preset, or none chosen: the cell's default. */
export type MachineSizeChoice = MachineSizePreset | "default";

export type MachineSizeOption = {
    value: MachineSizeChoice;
    label: string;
    /** Absent for the cell's default, which each cell sets. */
    size?: MachineSize;
    hint: string;
};

export const MACHINE_SIZE_OPTIONS: readonly MachineSizeOption[] = [
    {
        value: "default",
        label: "Host default",
        hint: "What the host gives when no size is chosen: 4 GB and 2 CPUs on Kodus cloud. Enough for most Node, Python and Ruby apps.",
    },
    {
        value: "small",
        label: "Small",
        size: { memoryMb: 4_096, cpus: 2 },
        hint: "Most interpreted apps and small builds.",
    },
    {
        value: "medium",
        label: "Medium",
        size: { memoryMb: 8_192, cpus: 4 },
        hint: "Large JavaScript bundles (webpack, Next.js), most Java and .NET builds.",
    },
    {
        value: "large",
        label: "Large",
        size: { memoryMb: 16_384, cpus: 8 },
        hint: "Heavy compiled builds: a large Go, Rust or C++ repository, or one that ran out of memory on Medium.",
    },
];

/** "8 GB · 4 CPUs". */
export const formatMachineSize = (s: MachineSize) =>
    `${s.memoryMb % 1_024 === 0 ? s.memoryMb / 1_024 : (s.memoryMb / 1_024).toFixed(1)} GB · ${s.cpus} CPU${s.cpus === 1 ? "" : "s"}`;

export const machineSizeOption = (choice: string) =>
    MACHINE_SIZE_OPTIONS.find((o) => o.value === choice);

/** A choice as a sentence reads it: "Large · 16 GB · 8 CPUs", or "the host default". */
export const machineSizeChoiceLabel = (choice: MachineSizeChoice) => {
    const o = machineSizeOption(choice);
    return o?.size
        ? `${o.label} · ${formatMachineSize(o.size)}`
        : "the host default";
};

/**
 * The saved choice is not the size the last setup booted at, so it waits for
 * the next setup. Absent on either side is the cell's default.
 */
export const machineSizeAwaitsSetup = (
    saved: MachineSizeChoice,
    bootedAt: MachineSize | undefined,
) => {
    const want = machineSizeOption(saved)?.size;
    return (
        want?.memoryMb !== bootedAt?.memoryMb || want?.cpus !== bootedAt?.cpus
    );
};
