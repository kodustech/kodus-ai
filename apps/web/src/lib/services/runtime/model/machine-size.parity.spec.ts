import {
    MACHINE_SIZE_PRESETS,
    MACHINE_SIZES,
} from "@libs/runtime/contracts/machine-size";

import {
    formatMachineSize,
    MACHINE_SIZE_OPTIONS,
    machineSizeAwaitsSetup,
    machineSizeChoiceLabel,
} from "./machine-size";

/**
 * The web shows its own copy of the presets (the isolated web build copies no
 * runtime lib, so it imports their types only). If the two drift, the page
 * shows one size and the hub asks the cell for another.
 */
describe("machine size parity (web ↔ libs/runtime)", () => {
    it("offers every preset of the contract with its memory and CPUs, and the cell default", () => {
        const presets = MACHINE_SIZE_OPTIONS.filter((o) => o.size);
        expect(presets.map((o) => o.value)).toEqual([...MACHINE_SIZE_PRESETS]);
        for (const preset of MACHINE_SIZE_PRESETS)
            expect(presets.find((o) => o.value === preset)?.size).toEqual(
                MACHINE_SIZES[preset],
            );
        expect(
            MACHINE_SIZE_OPTIONS.filter((o) => !o.size).map((o) => o.value),
        ).toEqual(["default"]);
    });
});

describe("machine size labels", () => {
    it("reads a size and a choice as a person does", () => {
        expect(formatMachineSize({ memoryMb: 8_192, cpus: 4 })).toBe(
            "8 GB · 4 CPUs",
        );
        expect(formatMachineSize({ memoryMb: 1_536, cpus: 1 })).toBe(
            "1.5 GB · 1 CPU",
        );
        expect(machineSizeChoiceLabel("large")).toBe("Large · 16 GB · 8 CPUs");
        expect(machineSizeChoiceLabel("default")).toBe("the host default");
    });

    it("waits for a setup only when the saved size is not the one it booted at", () => {
        expect(machineSizeAwaitsSetup("default", undefined)).toBe(false);
        expect(
            machineSizeAwaitsSetup("medium", { memoryMb: 8_192, cpus: 4 }),
        ).toBe(false);
        expect(machineSizeAwaitsSetup("large", undefined)).toBe(true);
        expect(
            machineSizeAwaitsSetup("default", { memoryMb: 8_192, cpus: 4 }),
        ).toBe(true);
    });
});
