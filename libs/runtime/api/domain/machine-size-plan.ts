// The plan's machine size ceiling, the way pool.ts bounds the warm pool: a
// bigger machine costs more per minute, so the plan names the largest preset
// an admin may choose. The cell bounds it once more with its own maximum
// (resources/size_unavailable). The ceiling holds for every environment: the
// hub may place an org's claim on a shared cell when its own cells are full,
// so an org with its own cells is not exempt from the plan here.

import { MACHINE_SIZE_PRESETS, type MachineSizePreset } from '@libs/runtime/contracts/machine-size';

export interface RuntimeMachineSizePlan {
    /** The largest preset an admin may choose (RUNTIME_MACHINE_SIZE_MAX). */
    maxPreset: MachineSizePreset;
}

// The presets are listed smallest first, so their position is their order.
const rank = (preset: MachineSizePreset) => MACHINE_SIZE_PRESETS.indexOf(preset);

/**
 * The size the setup asks for: the admin's choice under the plan's ceiling,
 * or none (the cell's default). Read at request time, so a plan lowered after
 * the choice was saved boots at the plan's largest instead of a size the
 * plan no longer pays for.
 */
export function effectiveMachineSize(plan: RuntimeMachineSizePlan, setting: MachineSizePreset | null | undefined): MachineSizePreset | null {
    if (!setting) return null;
    return rank(setting) > rank(plan.maxPreset) ? plan.maxPreset : setting;
}

export class MachineSizeAbovePlanError extends Error {}

/** An admin's choice, already known to be a preset or null: refused above the plan's ceiling. */
export function parseMachineSizeSetting(plan: RuntimeMachineSizePlan, value: MachineSizePreset | null): MachineSizePreset | null {
    if (value !== null && rank(value) > rank(plan.maxPreset)) throw new MachineSizeAbovePlanError(`machineSize is at most ${plan.maxPreset} on this plan`);
    return value;
}
