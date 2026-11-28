import type { EnvironmentSetupStep, SetupProgress } from "../contracts";
import { setupBootPhases } from "./boot-phases";

const step = (over: Partial<EnvironmentSetupStep>): EnvironmentSetupStep => ({
    name: "boot",
    state: "done",
    startedAt: "2026-11-11T12:00:00.000Z",
    ...over,
});
const progress = (bootPhases: SetupProgress["bootPhases"]): SetupProgress => ({
    phases: [],
    lines: [],
    updatedAt: "2026-11-11T12:30:00.000Z",
    bootPhases,
});
const done = [
    { name: "export layers", ms: 1_260_400 },
    { name: "yarn install", ms: 1_005_300 },
];
const live = [{ name: "yarn install", ms: 600_000, running: true as const }];

describe("where a setup's boot spent its time", () => {
    it("is the last boot's, not an earlier boot a repair replaced", () => {
        const steps = [
            step({ state: "failed", phases: [{ name: "npm ci", ms: 90_000 }] }),
            step({ phases: done }),
        ];
        expect(setupBootPhases({ steps, progress: progress(live) })).toEqual(
            done,
        );
    });

    it("is the live one while the boot runs, and nothing once a boot ended without any", () => {
        expect(
            setupBootPhases({
                steps: [step({ state: "running" })],
                progress: progress(live),
            }),
        ).toEqual(live);
        expect(
            setupBootPhases({ steps: [step({})], progress: progress(live) }),
        ).toBeUndefined();
    });
});
