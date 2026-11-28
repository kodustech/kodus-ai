import type { BootPhase, RuntimeEnvironment } from "../contracts";
import { lastBootStepIndex } from "./environment";

/**
 * Where a setup's boot spent its time: its last boot step's phases (also of
 * a boot that did not come up), else the live ones while it runs.
 */
export const setupBootPhases = (
    setup:
        | Pick<NonNullable<RuntimeEnvironment["setup"]>, "steps" | "progress">
        | undefined,
): BootPhase[] | undefined => {
    if (!setup) return undefined;
    const step = setup.steps[lastBootStepIndex(setup.steps)];
    const phases = step?.phases?.length
        ? step.phases
        : step?.state === "running"
          ? setup.progress?.bootPhases
          : undefined;
    return phases?.length ? phases : undefined;
};
