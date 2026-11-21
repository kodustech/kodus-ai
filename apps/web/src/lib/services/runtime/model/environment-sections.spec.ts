import type { EnvironmentSetup, RuntimeEnvironment } from "../contracts";
import { settingsTakeaway, setupTakeaway } from "./environment-sections";

const at = "2026-11-10T12:00:00.000Z";
const setup = (patch: Partial<EnvironmentSetup> = {}): EnvironmentSetup => ({
    state: "active",
    steps: [],
    blockers: [],
    requestedAt: at,
    updatedAt: at,
    finishedAt: "2026-11-10T12:04:10.000Z",
    sha: "b".repeat(40),
    ...patch,
});
const env = (patch: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment => ({
    environmentId: "env-1",
    repositoryId: "r1",
    repositoryName: "acme/shop",
    state: "active",
    ...patch,
});

describe("the last setup, read while its section is closed", () => {
    it("a setup that finished ready says how long it took", () => {
        expect(setupTakeaway(env({ setup: setup() }))).toBe(
            "Finished ready in 4 min 10 s.",
        );
    });

    it("a failed setup says the step it stopped at", () => {
        expect(
            setupTakeaway(
                env({
                    state: "blocked",
                    setup: setup({
                        state: "blocked",
                        steps: [
                            { name: "recipe", state: "done" },
                            { name: "boot", state: "failed" },
                        ] as EnvironmentSetup["steps"],
                    }),
                }),
            ),
        ).toBe("Stopped at Boot on a machine after 4 min 10 s.");
    });

    it("a setup in progress names the step it is on", () => {
        expect(
            setupTakeaway(
                env({
                    state: "setting_up",
                    setup: setup({
                        state: "setting_up" as EnvironmentSetup["state"],
                        finishedAt: undefined,
                        steps: [
                            { name: "recipe", state: "done" },
                            { name: "boot", state: "running" },
                        ] as EnvironmentSetup["steps"],
                    }),
                }),
            ),
        ).toBe("Now: Boot on a machine.");
    });

    it("an environment never set up has nothing recorded", () => {
        expect(setupTakeaway(env())).toBe("No setup recorded yet.");
        expect(setupTakeaway(env({ state: "setup_requested" }))).toBe(
            "Waiting for the Runtime to pick up the request.",
        );
    });
});

describe("the settings, read while their section is closed", () => {
    it("say what each setting is now, the defaults in words", () => {
        expect(
            settingsTakeaway(
                env({
                    machineSize: null,
                    forkPullRequests: "require_approval",
                    pool: {
                        size: 1,
                        setting: null,
                        defaultSize: 1,
                        maxSize: 3,
                    },
                    egressApprovals: [],
                }),
            ),
        ).toBe(
            "Default machine size · forks wait for a maintainer · 1 machine kept ready · no extra outbound hosts",
        );
    });

    it("a chosen size, forks off, no pool and approved hosts", () => {
        expect(
            settingsTakeaway(
                env({
                    machineSize: "large",
                    forkPullRequests: "skip",
                    pool: { size: 0, setting: 0, defaultSize: 1, maxSize: 3 },
                    egressApprovals: [
                        { host: "a.example.com" },
                        { host: "b.example.com" },
                    ] as RuntimeEnvironment["egressApprovals"],
                }),
            ),
        ).toBe(
            "Large machines · forks do not run · no machine kept ready · 2 approved outbound hosts",
        );
    });

    it("leaves out what the API does not send, or sends in a shape it does not know", () => {
        expect(settingsTakeaway(env({ egressApprovals: [] }))).toBe(
            "No extra outbound hosts",
        );
        expect(
            settingsTakeaway(
                env({
                    forkPullRequests:
                        "later" as RuntimeEnvironment["forkPullRequests"],
                }),
            ),
        ).toBe("No extra outbound hosts");
    });
});
