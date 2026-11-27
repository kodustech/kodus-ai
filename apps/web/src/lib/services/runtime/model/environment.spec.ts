import type { EnvironmentSetup } from "../contracts";
import {
    activeSetupMs,
    currentSetup,
    currentSetupCommit,
    environmentBootMs,
    environmentSetupMs,
    environmentHref,
    environmentNextStep,
    environmentStatus,
    hasEnvironmentMetrics,
    isEnvironmentBusy,
    recipeReauthorWords,
    isNotSetUp,
    lastBootStepIndex,
    plainBootFailure,
    setupActionLabel,
    setupRepairNotes,
    setupStepTitle,
    templateWords,
} from "./environment";

const at = "2026-10-31T00:00:00Z";
const setup = (patch: Partial<EnvironmentSetup> = {}): EnvironmentSetup => ({
    state: "active",
    steps: [],
    blockers: [],
    requestedAt: at,
    updatedAt: at,
    ...patch,
});
const blocked = (kind: string) =>
    setup({
        state: "blocked",
        blockers: [{ kind, signature: "s", message: "npm ci failed", at }],
    });

describe("environmentStatus (screens 2 to 4)", () => {
    // The dev cell evicted calcom's build cache at 07:31 and the environment
    // kept saying "Ready" while its PR built cold past the boot's wait.
    it("an active environment whose build cache the cell removed needs a setup again, and says why and when", () => {
        const status = environmentStatus({
            state: "active",
            setup: setup(),
            buildCache: { state: "evicted", evictedAt: "2026-11-13T07:31:31.000Z", cellId: "cell-1", reason: "disk_floor" },
        });
        expect(status).toMatchObject({ label: "Needs setup again", tone: "warning" });
        expect(status.detail).toContain("The build cache of this environment was removed to free disk on 2026-11-13 07:31 UTC.");
        expect(status.detail).toContain("Set up again.");
    });

    it("an evicted build cache says how much space the volume had and what it needs, so the next Run being cold is no mystery", () => {
        const GB = 2 ** 30;
        const status = environmentStatus({
            state: "active",
            setup: setup(),
            buildCache: { state: "evicted", evictedAt: "2026-11-13T07:31:31.000Z", cellId: "cell-1", reason: "disk_floor", freeBytes: 8 * GB, floorBytes: 20 * GB },
        });
        expect(status.detail).toContain("The build cache was not kept: the host's volume has 8 GB free and it needs 20 GB; the next Run starts cold.");
    });

    it("says ready, setting up, a missing secret or a boot failure", () => {
        expect(environmentStatus(undefined)).toMatchObject({
            label: "No environment",
        });
        expect(
            environmentStatus({ state: "active", setup: setup() }),
        ).toMatchObject({ label: "Ready", tone: "success" });
        expect(
            environmentStatus({
                state: "setting_up",
                setup: setup({ state: "setting_up" }),
            }),
        ).toMatchObject({ label: "Setting up" });
        expect(environmentStatus({ state: "setup_requested" })).toMatchObject({
            label: "Setting up",
        });
        // Setups of one organization run a few at a time: a request waiting
        // while another of the organization sets up says so.
        const org = [
            { environmentId: "a", state: "setting_up" as const },
            { environmentId: "b", state: "setup_requested" as const },
        ];
        expect(environmentStatus(org[1], org)).toMatchObject({
            label: "Waiting",
            detail: "Waiting for another setup of this organization",
        });
        expect(
            environmentStatus(org[1], [org[1], { environmentId: "c", state: "active" as const }]),
        ).toMatchObject({ label: "Setting up" });
        expect(
            environmentStatus({
                state: "blocked",
                setup: blocked("missing_env"),
            }),
        ).toMatchObject({ label: "Needs 1 secret", tone: "warning" });
        expect(
            environmentStatus({
                state: "blocked",
                setup: blocked("toolchain"),
            }),
        ).toMatchObject({
            label: "Boot failed",
            tone: "danger",
            detail: "npm ci failed",
        });
        expect(
            environmentStatus({
                state: "blocked",
                setup: blocked("no_recipe"),
            }),
        ).toMatchObject({ label: "No setup file", tone: "warning" });
        expect(
            environmentStatus({
                state: "blocked",
                setup: blocked("recipe_invalid"),
            }),
        ).toMatchObject({ label: "Invalid setup file", tone: "warning" });
        expect(
            environmentStatus({
                state: "blocked",
                setup: blocked("cell_unavailable"),
            }),
        ).toMatchObject({ label: "No machine connected", tone: "warning" });
    });

    it("blocked because no connected cell gives the isolation it asks: says so, not a failed boot", () => {
        expect(
            environmentStatus({ state: "blocked", setup: blocked("capacity") }),
        ).toMatchObject({
            label: "No suitable machine",
            tone: "warning",
            detail: expect.stringContaining("your repository is not the cause"),
        });
    });

    it("an active product row without any setup was never set up", () => {
        expect(environmentStatus({ state: "active" })).toMatchObject({
            label: "Not set up",
            tone: "neutral",
        });
        expect(environmentStatus({})).toMatchObject({ label: "Not set up" });
    });

    it("follows the API's merged state, not an older setup record", () => {
        // A rebuild of a ready environment: the API answers setup_requested
        // while `setup` is still the previous, active one.
        const rebuilding = {
            state: "setup_requested" as const,
            setup: setup({ state: "active" }),
        };
        expect(environmentStatus(rebuilding)).toMatchObject({
            label: "Setting up",
        });
        expect(isEnvironmentBusy(rebuilding)).toBe(true);
        expect(setupActionLabel(rebuilding)).toBe("Setting up…");
        // A new setup that failed is blocked even if an older one was ready.
        expect(
            environmentStatus({
                state: "blocked",
                setup: blocked("toolchain"),
            }),
        ).toMatchObject({ label: "Boot failed" });
    });

    // demo-kodus-ai's size.disk and xfile-review-fixtures' Git API timeout were
    // refused before any machine started, and the list said "Boot failed".
    it.each([
        ["resources", "The recipe requires disk enforcement, which is not supported by this Runtime path; no machine was started."],
        ["git_unavailable", "The Git API did not answer the default branch head; ask for the setup again."],
    ])("a %s refusal before any machine started is Not started, with its own words", (kind, message) => {
        const status = environmentStatus({
            state: "blocked",
            setup: setup({ state: "blocked", blockers: [{ kind, signature: `setup:${kind}`, message, at }] }),
        });
        expect(status).toMatchObject({ label: "Not started", tone: "warning", detail: message });
    });

    it("names the set-up action after what exists", () => {
        expect(setupActionLabel(undefined)).toBe("Set up");
        expect(setupActionLabel({ state: "active" })).toBe("Set up");
        expect(setupActionLabel({ state: "active", setup: setup() })).toBe(
            "Set up again",
        );
        expect(
            setupActionLabel({ state: "blocked", setup: blocked("toolchain") }),
        ).toBe("Set up again");
        expect(isEnvironmentBusy({ state: "active", setup: setup() })).toBe(
            false,
        );
    });

    it("keeps the last ready setup as the current one", () => {
        expect(
            currentSetup({ state: "setup_requested", setup: setup() })?.state,
        ).toBe("active");
        expect(
            currentSetup({ state: "blocked", setup: blocked("toolchain") }),
        ).toBeUndefined();
    });

    // The commit Runs boot from is the active setup's, else the one the setup built the primary repository at, else none.
    it("names the commit Runs boot from, or none when the setup records none", () => {
        const sha = "a1b2c3d4e5f6".padEnd(40, "0");
        expect(
            currentSetupCommit({ setup: setup({ sha, branch: "main" }) }),
        ).toEqual(expect.stringMatching(/^a1b2c3d/));
        expect(
            currentSetupCommit({
                setup: setup({ branch: "main" }),
                repositories: [
                    {
                        repositoryId: "r1",
                        repositoryName: "api",
                        fullName: "acme/api",
                        alias: "api",
                        role: "primary",
                        triggers: true,
                        pairBranches: false,
                        lastSetupSha: sha,
                    },
                ],
            }),
        ).toEqual(expect.stringMatching(/^a1b2c3d/));
        expect(currentSetupCommit({ setup: setup() })).toBeUndefined();
        expect(
            currentSetupCommit({ setup: setup({ sha, state: "blocked" }) }),
        ).toBeUndefined();
    });
});

describe("environment timings", () => {
    it("boot time sums the boot and ready steps of the last setup", () => {
        const step = (
            name: "boot" | "ready" | "resolve_ref",
            durationMs: number,
        ) => ({
            name,
            state: "done" as const,
            startedAt: at,
            durationMs,
        });
        expect(
            environmentBootMs({
                setup: setup({
                    steps: [
                        step("resolve_ref", 500),
                        step("boot", 100_000),
                        step("ready", 8_000),
                    ],
                }),
            }),
        ).toBe(108_000);
        expect(environmentBootMs({})).toBeUndefined();
    });

    it("setup time runs from the request to the end", () => {
        expect(
            environmentSetupMs({
                setup: setup({ finishedAt: "2026-10-31T00:01:30Z" }),
            }),
        ).toBe(90_000);
        expect(environmentSetupMs({ setup: setup() })).toBeUndefined();
    });

    it("the setup time is the active setup's, or the last that booted, never a failed one", () => {
        const finished = { finishedAt: "2026-10-31T00:01:30Z" };
        expect(
            activeSetupMs({ setup: setup({ ...finished, state: "active" }) }),
        ).toBe(90_000);
        expect(
            activeSetupMs({ setup: setup({ ...finished, state: "blocked" }) }),
        ).toBeUndefined();
        expect(
            activeSetupMs({
                setup: setup({
                    ...finished,
                    state: "blocked",
                    lastActive: {
                        finishedAt: "2026-10-30T00:00:00Z",
                        totalMs: 42_000,
                        phases: [],
                    },
                }),
            }),
        ).toBe(42_000);
    });
});

describe("environmentNextStep (the top of the environment page)", () => {
    const step = (state: any, s?: EnvironmentSetup) =>
        environmentNextStep({ environmentId: "env-1", state, setup: s });
    const recipe = (patch: Partial<NonNullable<EnvironmentSetup["recipe"]>>) => ({
        path: ".kodus/workspace.yaml",
        sha: "a".repeat(40),
        state: "found" as const,
        ...patch,
    });

    it("never set up: one action, the setup", () => {
        expect(step("active")).toMatchObject({
            title: "Not set up yet",
            action: { kind: "setup" },
        });
        expect(step(undefined).action).toEqual({ kind: "setup" });
    });

    it("setting up: points at the steps, never at another setup", () => {
        for (const state of ["setup_requested", "setting_up"])
            expect(step(state, setup({ state: "setting_up" }))).toMatchObject({
                title: "Setting up",
                action: { kind: "link", href: "#setup" },
            });
    });

    it("blocked: a missing secret, no recipe, no cell or a failed boot each lead somewhere", () => {
        expect(step("blocked", blocked("missing_env"))).toMatchObject({
            title: "Needs 1 secret",
            action: { label: "Open the blocker", href: "#blockers" },
        });
        expect(step("blocked", blocked("no_recipe")).action).toMatchObject({
            href: "#blockers",
        });
        expect(
            step(
                "blocked",
                setup({
                    state: "blocked",
                    recipe: recipe({
                        state: "absent",
                        inference: { reason: "no_build_files", message: "m" },
                    }),
                }),
            ),
        ).toMatchObject({
            title: "No setup file yet",
            action: { label: "Add a setup file", href: "#recipe" },
        });
        expect(step("blocked", blocked("cell_unavailable")).action).toMatchObject({
            href: "/runtime/environments#cells",
        });
        expect(step("blocked", blocked("recipe_invalid")).action).toMatchObject({
            href: "#setup",
        });
        expect(step("blocked", blocked("boot_timeout"))).toMatchObject({
            tone: "danger",
            detail: "npm ci failed",
            action: { href: "#blockers" },
        });
    });

    it("blocked, but Kody's fix booted the inferred recipe twice: the recipe PR", () => {
        const s = setup({
            state: "blocked",
            blockers: [{ kind: "boot_timeout", signature: "s", message: "x", at }],
            recipe: recipe({ origin: "inferred", content: "version: 1" }),
            learn: {
                tried: [],
                attempts: [],
                proven: {
                    signature: "s",
                    fix: { id: "f", action: "a", label: "a longer health timeout" },
                    digest: "d",
                    cleanBoots: 2,
                    origin: "inferred",
                    content: "version: 1",
                },
            } as any,
        });
        expect(step("blocked", s)).toMatchObject({
            title: "Kody found a fix for the setup file",
            action: { href: "#recipe" },
        });
    });

    it("ready with a recipe Kody wrote: prove it, then add it by PR", () => {
        const once = setup({ recipe: recipe({ origin: "authored", cleanBoots: 1 }) });
        expect(step("active", once).action).toEqual({ kind: "setup" });
        const twice = setup({ recipe: recipe({ origin: "inferred", cleanBoots: 2 }) });
        expect(step("active", twice).action).toMatchObject({ href: "#recipe" });
    });

    it("ready with the repository's recipe: try it on past PRs", () => {
        expect(step("active", setup({ recipe: recipe({}) }))).toMatchObject({
            title: "Ready",
            action: { label: "Simulate on past PRs", href: "#simulation" },
        });
    });
});

describe("an environment known only from earlier Runs", () => {
    const runOnly = {
        environmentId: "h1-pkg-shop-repo",
        repositoryId: "r1",
        managed: false,
        setup: setup(),
    };
    const otherRunOnly = { ...runOnly, environmentId: "h2-pkg-shop-repo" };
    const managed = {
        environmentId: "env-1",
        repositoryId: "r1",
        managed: true,
        state: "active" as const,
    };

    it("offers no setup, and points to the managed environment of its repository when there is one", () => {
        expect(
            environmentNextStep(runOnly, [runOnly, otherRunOnly, managed])
                .action,
        ).toMatchObject({ kind: "link", href: environmentHref("env-1") });
        expect(
            environmentNextStep(runOnly, [runOnly, otherRunOnly]).action,
        ).toBeUndefined();
    });
});

describe("environment page helpers", () => {
    it("links the environment page and its sections", () => {
        expect(environmentHref("env/1")).toBe("/runtime/environments/env%2F1");
        expect(environmentHref("env-1", "recipe")).toBe(
            "/runtime/environments/env-1#recipe",
        );
    });

    it("a new environment has no metric to show", () => {
        expect(hasEnvironmentMetrics(undefined)).toBe(false);
        expect(hasEnvironmentMetrics({ runs7d: 0, egressBlocked: [] })).toBe(false);
        expect(hasEnvironmentMetrics({ runs7d: 2 })).toBe(true);
        expect(
            hasEnvironmentMetrics({ setupBoots: { boots7d: 1, bootRate7d: 1 } }),
        ).toBe(true);
    });
});

describe("plainBootFailure (the boot failure in a table row)", () => {
    const plumbing =
        "compose_up: dockergvisor: build app: docker run --rm --name kodus-build-x1 --runtime runsc --network kodus-claim-ab12 -- … ";
    it("names the Dockerfile line, its command and the exit code", () => {
        expect(
            plainBootFailure(
                `${plumbing}postinstall: Done ------ .kodus/Dockerfile:14 -------------------- 12 | COPY . . 13 | 14 | >>> RUN pnpm install --frozen-lockfile 15 | 16 | RUN pnpm build:api -------------------- error: failed to solve: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete successfully: exit code: 1`,
            ),
        ).toEqual(
            expect.stringMatching(
                /\.kodus\/Dockerfile:14.*RUN pnpm install --frozen-lockfile.*exit code 1/,
            ),
        );
    });

    it("takes the command from the process when the Dockerfile line was cut out", () => {
        expect(
            plainBootFailure(
                `${plumbing}lter=nocodb-sdk 15 | 16 | RUN pnpm build -------------------- error: failed to solve: process "/bin/sh -c pnpm install --frozen-lockfile --filter=nocodb" did not complete successfully: exit code: 1`,
            ),
        ).toEqual(
            expect.stringMatching(
                /pnpm install --frozen-lockfile --filter=nocodb.*exit code 1/,
            ),
        );
    });

    it("says the build stopped with no error line, with what it last printed", () => {
        expect(
            plainBootFailure(
                `${plumbing}#7 7.731 Fetched 82.8 MB in 2s (50.6 MB/s) #7 7.810 (Reading database ...`,
            ),
        ).toMatch(/Reading database \.\.\.$/);
    });

    it("reads a build of any service, not only app", () => {
        expect(
            plainBootFailure(
                'compose_up: dockergvisor: build api: docker run --rm -- … error: failed to solve: process "/bin/sh -c go build ./..." did not complete successfully: exit code: 2',
            ),
        ).toEqual(expect.stringMatching(/go build \.\/\.\.\..*exit code 2/));
    });

    it("leaves any other message as it is", () => {
        expect(
            plainBootFailure("the cell disconnected while the claim was booting"),
        ).toBe("the cell disconnected while the claim was booting");
        expect(plainBootFailure(undefined)).toBeUndefined();
    });
});

describe("environmentNextStep after a recipe Kody wrote failed to boot", () => {
    it("says it in plain words and offers the setup that hands the failure back to Kody", () => {
        const step = environmentNextStep({
            environmentId: "env-1",
            state: "blocked",
            setup: {
                state: "blocked",
                steps: [],
                requestedAt: "2026-11-11T12:00:00.000Z",
                updatedAt: "2026-11-11T12:10:00.000Z",
                recipe: { path: ".kodus/workspace.yaml", sha: "a".repeat(40), state: "found", origin: "authored", content: "version: 1" },
                blockers: [
                    {
                        kind: "compose_up",
                        message:
                            'compose_up: dockergvisor: build app: docker run --rm --name kodus-build-x -- … error: failed to solve: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete successfully: exit code: 1',
                    },
                ],
            },
        } as any);
        expect(step).toMatchObject({
            tone: "danger",
            action: { kind: "setup" },
        });
        // The plain boot failure, and that the next setup hands it back to Kody.
        expect(step.detail).toContain("pnpm install --frozen-lockfile");
        expect(step.detail).toContain("Kody rewrites");
    });
});

describe("environmentNextStep after a setup the recipe Kody wrote never had its chance in", () => {
    const blockedWith = (blocker: { kind: string; signature: string; message: string }) =>
        environmentNextStep({
            environmentId: "env-1",
            state: "blocked",
            setup: {
                state: "blocked",
                steps: [],
                requestedAt: "2026-11-11T12:00:00.000Z",
                updatedAt: "2026-11-11T12:10:00.000Z",
                recipe: { path: ".kodus/workspace.yaml", sha: "a".repeat(40), state: "found", origin: "authored", content: "version: 1" },
                blockers: [{ ...blocker, at: "2026-11-11T12:10:00.000Z" }],
            },
        } as any);

    it.each([
        ["Kodus's platform", { kind: "platform", signature: "setup:ClaimLeaseUnavailableError", message: "the claim lease was lost" }],
        ["no room on a cell", { kind: "resources", signature: "no_capacity", message: "no cell had room" }],
        ["a size no cell grants", { kind: "resources", signature: "size_unavailable", message: "no cell grants this size" }],
    ])("%s never says Kody rewrites the recipe", (_name, blocker) => {
        const step = blockedWith(blocker);
        expect(step).toMatchObject({ tone: "warning", title: "The setup stopped before the setup file could boot", action: { kind: "setup" } });
        expect(step.detail).not.toMatch(/rewrites/);
        expect(step.detail).toContain(blocker.message);
    });
});

describe("environmentNextStep when no connected cell gives the isolation the setup asks", () => {
    it("points at the cells and never says Kody rewrites the recipe Kody wrote", () => {
        const step = environmentNextStep({
            environmentId: "env-1",
            state: "blocked",
            setup: {
                state: "blocked",
                steps: [],
                requestedAt: "2026-11-11T12:00:00.000Z",
                updatedAt: "2026-11-11T12:10:00.000Z",
                recipe: { path: ".kodus/workspace.yaml", sha: "a".repeat(40), state: "found", origin: "authored", content: "version: 1" },
                blockers: [{ kind: "capacity", signature: "isolation_unavailable", message: "the claim asks for VM isolation", at: "2026-11-11T12:10:00.000Z" }],
            },
        } as any);
        expect(step).toMatchObject({
            tone: "warning",
            title: "No suitable machine",
            action: { label: "Go to hosts", href: "/runtime/environments#cells" },
        });
        expect(step.detail).not.toMatch(/rewrites/);
    });
});

describe("a setup refused for the org's machine minutes", () => {
    const refused = {
        environmentId: "env-1",
        state: "blocked",
        setup: {
            state: "blocked",
            steps: [],
            requestedAt: "2026-11-11T12:00:00.000Z",
            updatedAt: "2026-11-11T12:10:00.000Z",
            recipe: { path: ".kodus/workspace.yaml", sha: "a".repeat(40), state: "found", origin: "authored", content: "version: 1" },
            blockers: [{ kind: "resources", signature: "machine_minutes_exhausted", message: "the organization used 100 of its 100 machine minutes today (UTC)", at: "2026-11-11T12:10:00.000Z" }],
        },
    } as any;

    it("says new setups and Runs wait for the daily reset, never that the build failed or that Kody rewrites the recipe", () => {
        const step = environmentNextStep(refused);
        expect(step.tone).toBe("warning");
        expect(step.detail).toMatch(/reset/i);
        expect(step.detail).not.toMatch(/rewrites/);
        expect(step.action).toBeUndefined();
        const status = environmentStatus(refused);
        expect(status.tone).toBe("warning");
        expect(status.detail).toBe(step.detail);
    });
});

describe("isNotSetUp", () => {
    it("is true with no state, or for an active product row with no setup recorded", () => {
        expect(isNotSetUp({ state: undefined, setup: undefined })).toBe(true);
        expect(isNotSetUp({ state: "active", setup: undefined })).toBe(true);
        expect(isNotSetUp({ state: "active", setup: setup() })).toBe(false);
        expect(isNotSetUp({ state: "blocked", setup: undefined })).toBe(false);
    });
});

describe("repairs of Kody's recipe inside a setup", () => {
    const repair = (
        n: number,
        outcome: NonNullable<EnvironmentSetup["repairs"]>[number]["outcome"],
        kind = "toolchain",
    ): NonNullable<EnvironmentSetup["repairs"]>[number] => ({
        n,
        max: 2,
        blocker: {
            kind,
            signature:
                kind === "not_ready"
                    ? "setup:not_ready:app:3000/"
                    : "compose_up",
            title:
                kind === "not_ready"
                    ? "GET / on app:3000 answered 503"
                    : "The project failed to build or start",
        },
        failedDigest: `sha256:${n}`,
        outcome,
        at,
    });

    it("says each rewrite in plain words, with its attempt and the blocker that made it", () => {
        expect(
            setupRepairNotes(
                setup({
                    repairs: [
                        repair(1, "blocked", "not_ready"),
                        repair(2, "booted"),
                    ],
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                key: "repair-1",
                text: expect.stringContaining("attempt 1 of 2"),
                blocker: "GET / on app:3000 answered 503",
            }),
            expect.objectContaining({
                key: "repair-2",
                text: expect.stringContaining("attempt 2 of 2"),
                blocker: "The project failed to build or start",
            }),
        ]);
        expect(
            setupRepairNotes(setup({ repairs: [repair(1, "writing")] }))[0]
                .text,
        ).toContain("attempt 1 of 2");
        expect(
            setupRepairNotes(setup({ repairs: [repair(1, "budget")] }))[0].text,
        ).toContain("the setup's LLM budget is spent");
    });

    it("says Kody was not asked when the machine could not download the repository again", () => {
        expect(
            setupRepairNotes(setup({ repairs: [repair(1, "no_token")] }))[0]
                .text,
        ).toMatch(/not asked.*could not download the repository again/i);
    });

    it("says nothing for a setup that made no repair", () => {
        expect(setupRepairNotes(setup())).toEqual([]);
        expect(setupRepairNotes(undefined)).toEqual([]);
    });

    it("labels a step with the repair it belongs to, and the live progress goes to the last boot", () => {
        expect(setupStepTitle({ name: "boot" })).not.toBe("boot");
        expect(setupStepTitle({ name: "boot", repair: 1 })).toContain(
            "repair 1",
        );
        expect(
            lastBootStepIndex([
                { name: "recipe" },
                { name: "boot" },
                { name: "recipe" },
                { name: "boot" },
                { name: "ready" },
            ]),
        ).toBe(3);
        expect(lastBootStepIndex([{ name: "recipe" }])).toBe(-1);
    });
});

describe("recipeReauthorWords (the recipe card)", () => {
    // demo-nextjs kept its next dev recipe after the author was told to start the
    // production server: the screen now says when the recipe was written again.
    it("says the recipe was updated, kept as it was, or kept because the rewrite failed its checks", () => {
        const reason = "an app with pages starts on its production server (next start, not next dev)";
        expect(recipeReauthorWords({ reauthor: { version: 2, from: 1, reason, outcome: "updated" } })).toBe(`Setup file updated to author v2, written again for its rule: ${reason}.`);
        expect(recipeReauthorWords({ reauthor: { version: 2, from: 1, reason, outcome: "kept" } })).toContain("did not pass its checks, so the setup file that booted stays");
        expect(recipeReauthorWords({ reauthor: { version: 2, from: 1, reason, outcome: "unchanged" } })).toContain("kept as it was under author v2");
        expect(recipeReauthorWords({})).toBeUndefined();
    });

    // demo-nextjs on 2026-11-13: rewritten under v2, the recipe still runs `next dev` (next/font/google), and the card
    // read "Recipe updated to author v2: an app with pages starts on its production server (next start, not next dev)."
    it("never prints the revision's rule as what the recipe does: Kody's notes say that", () => {
        const reason = "an app with pages starts on its production server (next start, not next dev)";
        const notes = "The app imports next/font/google, so it runs next dev.";
        const updated = recipeReauthorWords({ reauthor: { version: 2, from: 1, reason, outcome: "updated" } }, notes);
        expect(updated).toBe(`Setup file updated to author v2. Kody's notes below say what it does now. It was written again for this rule: ${reason}.`);
        expect(recipeReauthorWords({ reauthor: { version: 2, from: 1, reason, outcome: "unchanged" } })).toBe(`Setup file kept as it was under author v2, whose rule is: ${reason}.`);
    });
});

describe("the environment template line", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const t = (over: Partial<NonNullable<Parameters<typeof templateWords>[0]>["template"]> = {}) => ({
        template: { mainSha: "abcdef0123456789", builtAt: "2026-11-24T12:00:00Z", commitsBehind: 0, ...over },
    });

    it("is nothing while the environment has no ready template", () => {
        expect(templateWords(undefined, now)).toBeUndefined();
        expect(templateWords({}, now)).toBeUndefined();
    });
    it("names the main commit the template holds and its age in days", () => {
        const words = templateWords(t(), now)!;
        expect(words).toContain("main abcdef0");
        expect(words).toContain("built 3 days ago");
        expect(words).not.toContain("since");
    });
    it.each([
        ["2026-11-27T11:30:00Z", "built less than an hour ago"],
        ["2026-11-27T07:00:00Z", "built 5 hours ago"],
        ["2026-11-27T11:00:00Z", "built 1 hour ago"],
        ["2026-11-25T13:00:00Z", "built 47 hours ago"],
        ["2026-11-25T12:00:00Z", "built 2 days ago"],
    ])("says a template built at %s as %s", (builtAt, want) => expect(templateWords(t({ builtAt }), now)).toContain(want));
    it("says how many main commits came after it, singular and plural", () => {
        expect(templateWords(t({ commitsBehind: 1 }), now)).toContain(", 1 main commit since.");
        expect(templateWords(t({ commitsBehind: 12 }), now)).toContain(", 12 main commits since.");
    });
    it("says so when the template was built before its main commit was recorded", () => {
        expect(templateWords(t({ mainSha: undefined }), now)).toContain("main commit not recorded");
    });
});

