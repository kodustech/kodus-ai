import type {
    EnvironmentMetrics,
    EnvironmentSetup,
    EnvironmentSetupRepair,
    EnvironmentSetupStep,
    RuntimeEnvironment,
} from "../contracts";
import { runStateLabel, setupStepLabel, type Tone } from "../labels";
import { CELLS_SECTION_ID } from "./blockers";
import { machineMinutesBlockerWords } from "./machine-minutes";

// The status of an environment, as screens 2, 3 and 4 say it.
//
// `env.state` is already the API's merged answer
// (libs/runtime/api/.../environments.use-cases.ts): the worker's setup record
// once it answered the latest request, else the product row. The UI never
// re-derives it from `env.setup`, which can be an older setup while a new
// one is requested; `setup` only gives the details (steps, sha, blockers).

export type EnvironmentStatus = { label: string; tone: Tone; detail?: string };

type EnvironmentLike = Pick<RuntimeEnvironment, "state" | "setup" | "managed"> &
    Partial<Pick<RuntimeEnvironment, "buildCache">>;

/** When the cell removed the build cache, as the screen says it (UTC day and minute). */
const evictedAtWords = (at: string) => {
    const t = Date.parse(at);
    return Number.isNaN(t)
        ? undefined
        : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/** Bytes as the screen says disk: GB with one decimal under 10, whole above. */
const gigabytes = (bytes: number) => {
    const gb = bytes / 2 ** 30;
    return gb < 10 ? gb.toFixed(1).replace(/\.0$/, "") : String(Math.round(gb));
};

/**
 * An active environment whose build cache its cell removed to free disk:
 * Runs still boot main from the bake, but every pull request builds from
 * nothing until a setup again (a large repository may not finish within its
 * boot's wait). The same words as the PR comment.
 */
export const buildCacheEvictedWords = (
    env: Pick<EnvironmentLike, "buildCache"> | undefined,
): string | undefined => {
    const c = env?.buildCache;
    if (c?.state !== "evicted") return undefined;
    const when = evictedAtWords(c.evictedAt);
    const disk =
        c.floorBytes && c.floorBytes > 0
            ? ` The build cache was not kept: the host's volume has ${gigabytes(c.freeBytes ?? 0)} GB free and it needs ${gigabytes(c.floorBytes)} GB; the next Run starts cold.`
            : "";
    return `The build cache of this environment was removed to free disk${when ? ` on ${when}` : ""}.${disk} Pull requests build with no cache, slower and maybe past their boot's wait, until a new setup restores it. Set up again.`;
};

/**
 * Known only from earlier Runs (an id with no product row): nothing sets it
 * up or configures it. An environment the API sends no flag for is managed.
 */
export const isRunOnlyEnvironment = (
    env: Pick<RuntimeEnvironment, "managed"> | undefined,
) => env?.managed === false;

type EnvironmentRef = Pick<
    RuntimeEnvironment,
    "environmentId" | "repositoryId" | "managed"
>;

/** The environment the product manages for the same repository: where one known only from earlier Runs points. */
export const managedEnvironmentOf = <E extends EnvironmentRef>(
    env: Pick<RuntimeEnvironment, "environmentId" | "repositoryId">,
    environments: readonly E[],
): E | undefined =>
    environments.find(
        (e) =>
            e.environmentId !== env.environmentId &&
            e.repositoryId === env.repositoryId &&
            !isRunOnlyEnvironment(e),
    );

/** A setup is requested or running: the screens poll and the set-up action waits. */
export const isEnvironmentBusy = (env: EnvironmentLike | undefined) =>
    env?.state === "setup_requested" || env?.state === "setting_up";

/** A product row that is "active" with no setup recorded was never set up. */
const neverSetUp = (env: EnvironmentLike) =>
    env.state === "active" && !env.setup;

/** Never set up: no state yet, or a product row with no setup recorded. */
export const isNotSetUp = <E extends EnvironmentLike>(
    env: E,
): env is E &
    ({ state?: undefined } | { state: "active"; setup?: undefined }) =>
    !env.state || neverSetUp(env);

/**
 * Refusals before any cell booted anything (capacity, size): the
 * runtime-worker's NOT_A_SETUP_BOOT (libs/runtime/run/environment-setup.ts).
 */
const NOT_A_SETUP_BOOT: ReadonlySet<string> = new Set([
    "org_capacity",
    "no_capacity",
    "size_unavailable",
    "machine_minutes_exhausted",
    "isolation_unavailable",
]);

/** Setup blockers the product raises before it asks for a machine (signature `setup:<kind>`). */
const NOT_STARTED_KINDS: ReadonlySet<string> = new Set([
    "resources",
    "git_unavailable",
    "unsupported_platform",
    "no_ref",
    "recipe_unreadable",
]);

/** A capacity blocker: the claim asks an isolation no connected cell gives, so nothing was sent. */
const NO_SUITABLE_CELL =
    "Nothing booted and your repository is not the cause: no connected machine gives the isolation this environment asks for. Connect one that does, then set up again.";

/**
 * Whether a blocked setup's first blocker is a failure of its recipe, the
 * kind Kody rewrites the recipe from on the next setup. Kodus's platform,
 * a refusal before anything booted and a missing cell are no verdict on the
 * recipe. The same rule as the runtime-worker's isRecipeFailureBlocker
 * (libs/runtime/run/environment-setup.ts), pinned by a parity test.
 */
export const isRecipeFailureBlocker = (
    b: { kind: string; signature: string } | undefined,
) =>
    !!b &&
    !(
        b.kind === "platform" ||
        b.kind === "cell_unavailable" ||
        b.signature === "cell_unavailable" ||
        NOT_A_SETUP_BOOT.has(b.signature)
    );

/**
 * A boot failure in words a developer acts on. The cell's message starts with
 * its own plumbing (`compose_up: dockergvisor: build app: docker run --rm
 * --name …`); what matters is the Dockerfile line the build stopped at, its
 * command and exit code, or, when the build died with no error line, the last
 * thing it printed. Anything else is shown as is.
 */
export const plainBootFailure = (message: string | undefined) => {
    if (!message) return message;
    const flat = message.replace(/\s+/g, " ").trim();
    // The cell names the service it builds (`build app:`, `build api:`).
    if (!/^compose_up:.*build [\w.-]+:/.test(flat)) return message;
    const at = /([\w./-]*Dockerfile[\w.-]*):(\d+) -{3,}/.exec(flat);
    const cmd =
        /\d+ \| >>> (.+?)(?= \d+ \| | -{5,}|$)/.exec(flat) ??
        /process "\/bin\/sh -c (.+?)" did not complete/.exec(flat);
    const exit = /did not complete successfully: exit code: (\d+)/.exec(flat);
    if (at || exit) {
        const where = at ? ` at ${at[1]}:${at[2]}` : "";
        const what = cmd ? ` (${cmd[1].trim()})` : "";
        const code = exit ? `, exit code ${exit[1]}` : "";
        return `The image build stopped${where}${what}${code}.`;
    }
    const tail = flat
        .slice(flat.lastIndexOf("…") + 1)
        .trim()
        .slice(-90);
    return `The image build stopped with no error line; it last printed: ${tail}`;
};

/**
 * The setup request waits its turn: setups of one organization run a few at
 * a time (the worker's RUNTIME_SETUP_PER_ORG), and until this one starts its
 * environment stays "setup_requested" while another of the organization is
 * "setting_up".
 */
const waitsForAnotherSetup = (
    env: EnvironmentLike & { environmentId?: string },
    organization: ReadonlyArray<
        Pick<RuntimeEnvironment, "environmentId" | "state">
    >,
) =>
    env.state === "setup_requested" &&
    organization.some(
        (e) =>
            e.environmentId !== env.environmentId && e.state === "setting_up",
    );

/** `organization`: the organization's environments, when the screen has them, to tell a setup waiting its turn. */
export const environmentStatus = (
    env: (EnvironmentLike & { environmentId?: string }) | undefined,
    organization: ReadonlyArray<
        Pick<RuntimeEnvironment, "environmentId" | "state">
    > = [],
): EnvironmentStatus => {
    if (!env) return { label: "No environment", tone: "neutral" };
    if (isRunOnlyEnvironment(env))
        return {
            label: "From earlier Runs",
            tone: "neutral",
            detail: "Known only from earlier Runs: there is nothing to set up here.",
        };
    if (!env.state || isNotSetUp(env))
        return { label: "Not set up", tone: "neutral" };
    switch (env.state) {
        case "active": {
            const evicted = buildCacheEvictedWords(env);
            if (evicted)
                return {
                    label: "Needs setup again",
                    tone: "warning",
                    detail: evicted,
                };
            return { label: "Ready", tone: "success" };
        }
        case "setup_requested":
        case "setting_up":
            return waitsForAnotherSetup(env, organization)
                ? {
                      label: "Waiting",
                      tone: "info",
                      detail: "Waiting for another setup of this organization",
                  }
                : { label: "Setting up", tone: "info" };
        case "blocked": {
            const blockers = env.setup?.blockers ?? [];
            const missing = blockers.filter(
                (b) => b.kind === "missing_env",
            ).length;
            if (missing)
                return {
                    label: `Needs ${missing} secret${missing === 1 ? "" : "s"}`,
                    tone: "warning",
                };
            const first = blockers[0];
            const outOfMinutes = machineMinutesBlockerWords(first);
            if (outOfMinutes)
                return {
                    label: "Out of machine minutes",
                    tone: "warning",
                    detail: outOfMinutes,
                };
            if (first?.kind === "no_recipe")
                return {
                    label: "No setup file",
                    tone: "warning",
                    detail: first.message,
                };
            if (first?.kind === "cell_unavailable")
                return {
                    label: "No machine connected",
                    tone: "warning",
                    detail: "Nothing booted: no machine was connected to take the setup.",
                };
            if (first?.kind === "capacity")
                return {
                    label: "No suitable machine",
                    tone: "warning",
                    detail: NO_SUITABLE_CELL,
                };
            if (first?.kind === "recipe_invalid")
                return {
                    label: "Invalid setup file",
                    tone: "warning",
                    detail: first.message,
                };
            // Refused before any machine started (the product's own checks,
            // runtime-setup-requester.service.ts): nothing booted, so not a boot failure.
            if (
                first &&
                NOT_STARTED_KINDS.has(first.kind) &&
                first.signature === `setup:${first.kind}`
            )
                return {
                    label: "Not started",
                    tone: "warning",
                    detail: first.message,
                };
            return {
                label: "Boot failed",
                tone: "danger",
                detail: plainBootFailure(first?.message),
            };
        }
        default:
            return { label: runStateLabel(env.state), tone: "neutral" };
    }
};

/**
 * What the last setup did with Kody's recipe when Kody's author instructions
 * changed in a way recipes must get: the one line the recipe card shows.
 */
export const recipeReauthorWords = (
    setup: Pick<EnvironmentSetup, "reauthor"> | undefined,
    notes?: string,
): string | undefined => {
    const r = setup?.reauthor;
    if (!r) return undefined;
    // The reason is the rule the recipe was written again for, never what the
    // recipe does: a rule has exceptions (demo-nextjs keeps `next dev` because
    // of next/font/google). Kody's notes, shown right below, say what it does.
    switch (r.outcome) {
        case "updated":
            return notes
                ? `Setup file updated to author v${r.version}. Kody's notes below say what it does now. It was written again for this rule: ${r.reason}.`
                : `Setup file updated to author v${r.version}, written again for its rule: ${r.reason}.`;
        case "unchanged":
            return `Setup file kept as it was under author v${r.version}, whose rule is: ${r.reason}.`;
        case "kept":
            return `Kody's rewrite for author v${r.version} did not pass its checks, so the setup file that booted stays (${r.reason}).`;
    }
};

/** The words of the button that asks for a setup. */
export const setupActionLabel = (env: EnvironmentLike | undefined) =>
    isEnvironmentBusy(env)
        ? "Setting up…"
        : env?.setup
          ? "Set up again"
          : "Set up";

/** The last setup that finished ready: what Runs boot from. */
export const currentSetup = (env: EnvironmentLike | undefined) =>
    env?.setup?.state === "active" ? env.setup : undefined;

/**
 * The short commit Runs boot from: the active setup's, else the one it built
 * the primary repository at (the API's `lastSetupSha`); undefined when
 * neither is recorded, so the screen leaves the commit out.
 */
export const currentSetupCommit = (
    env: Pick<RuntimeEnvironment, "setup" | "repositories"> | undefined,
): string | undefined => {
    if (env?.setup?.state !== "active") return undefined;
    const sha =
        env.setup.sha?.trim() ||
        env.repositories
            ?.find((r) => r.role === "primary")
            ?.lastSetupSha?.trim();
    return sha ? sha.slice(0, 7) : undefined;
};

const stepMs = (s: {
    durationMs?: number;
    startedAt: string;
    finishedAt?: string;
}) =>
    s.durationMs ??
    (s.finishedAt
        ? Math.max(0, Date.parse(s.finishedAt) - Date.parse(s.startedAt)) || 0
        : 0);

/** The boot of the last setup: the boot and ready steps, when recorded. */
export const environmentBootMs = (
    env: Pick<RuntimeEnvironment, "setup"> | undefined,
): number | undefined => {
    const steps = env?.setup?.steps?.filter(
        (s) => (s.name === "boot" || s.name === "ready") && s.state === "done",
    );
    if (!steps?.length) return undefined;
    const ms = steps.reduce((sum, s) => sum + stepMs(s), 0);
    return ms > 0 ? ms : undefined;
};

/** The whole last setup, requested to finished. */
export const environmentSetupMs = (
    env: Pick<RuntimeEnvironment, "setup"> | undefined,
): number | undefined => {
    const s = env?.setup;
    if (!s?.finishedAt) return undefined;
    const ms = Date.parse(s.finishedAt) - Date.parse(s.requestedAt);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/**
 * What the setup in use took: the active one, or else the last one that
 * booted. A setup that failed or still runs is never "the setup time".
 */
export const activeSetupMs = (
    env: Pick<RuntimeEnvironment, "setup"> | undefined,
): number | undefined => {
    if (env?.setup?.state === "active") return environmentSetupMs(env);
    return env?.setup?.lastActive?.totalMs;
};

/** A setup step's name in the step list, with the repair of Kody's recipe it belongs to. */
export const setupStepTitle = (
    step: Pick<EnvironmentSetupStep, "name" | "repair">,
) =>
    step.repair
        ? `${setupStepLabel(step.name)} (repair ${step.repair})`
        : setupStepLabel(step.name);

/** The index of the setup's last boot step: the one the cell's live progress belongs to. */
export const lastBootStepIndex = (
    steps: readonly Pick<EnvironmentSetupStep, "name">[],
) => steps.map((s) => s.name).lastIndexOf("boot");

const repairCause = (r: EnvironmentSetupRepair) =>
    r.blocker.kind === "not_ready"
        ? "the app did not answer"
        : "the build failed";

/**
 * Each time Kody rewrote its recipe inside the setup, in plain words, with
 * the blocker that made it (the catalog's title).
 */
export const setupRepairNotes = (
    setup: { repairs?: EnvironmentSetupRepair[] } | undefined,
): Array<{ key: string; text: string; blocker: string }> =>
    (setup?.repairs ?? []).map((r) => {
        const attempt = `(attempt ${r.n} of ${r.max})`;
        const cause = repairCause(r);
        const text: Record<EnvironmentSetupRepair["outcome"], string> = {
            writing: `Kody is rewriting the setup file because ${cause} ${attempt}.`,
            booting: `Kody rewrote the setup file after ${cause} ${attempt}. Booting it now.`,
            booted: `Kody rewrote the setup file after ${cause} ${attempt}. It booted.`,
            blocked: `Kody rewrote the setup file after ${cause} ${attempt}. It failed too.`,
            no_recipe: `Kody could not write another setup file after ${cause} ${attempt}.`,
            identical: `Kody gave back a setup file that had already failed ${attempt}.`,
            same_failure: `Kody's last setup file failed the same way as the one before it, so Kody stopped rewriting ${attempt}.`,
            refused: `Kody's new setup file after ${cause} did not pass the checks ${attempt}.`,
            unavailable: `Kody could not be reached to rewrite the setup file after ${cause} ${attempt}.`,
            budget: `Kody did not rewrite the setup file after ${cause}: the setup's LLM budget is spent ${attempt}.`,
            no_token: `Kody's rewrite was not asked: the machine could not download the repository again ${attempt}.`,
        };
        return {
            key: `repair-${r.n}`,
            text:
                text[r.outcome] ??
                `Kody rewrote the setup file after ${cause} ${attempt}.`,
            blocker: r.blocker.title,
        };
    });

/** ENV-06: the PR is offered once the inferred recipe booted from zero on this many clean machines. */
export const INFERRED_RECIPE_CLEAN_BOOTS = 2;

/** The sections of the environment page that other screens and the next step link to. */
export const ENVIRONMENT_SECTION = {
    repositories: "repositories",
    setup: "setup",
    recipe: "recipe",
    blockers: "blockers",
    simulation: "simulation",
    settings: "settings",
} as const;

/** The environment page, or one of its sections. */
export const environmentHref = (
    environmentId: string,
    section?: (typeof ENVIRONMENT_SECTION)[keyof typeof ENVIRONMENT_SECTION],
) =>
    `/runtime/environments/${encodeURIComponent(environmentId)}${section ? `#${section}` : ""}`;

/** Any number the metric cards can show; a new environment has none. */
export const hasEnvironmentMetrics = (
    metrics: EnvironmentMetrics | undefined,
) =>
    !!metrics &&
    (metrics.bootRate7d !== undefined ||
        metrics.readyP50Ms !== undefined ||
        metrics.readyP90Ms !== undefined ||
        !!metrics.runs7d ||
        !!metrics.setupBoots?.boots7d);

export type NextStepAction =
    { kind: "setup" } | { kind: "link"; label: string; href: string };

export type EnvironmentNextStep = {
    tone: Tone;
    title: string;
    detail: string;
    action?: NextStepAction;
};

type NextStepEnvironment = Pick<
    RuntimeEnvironment,
    "environmentId" | "state" | "setup" | "managed"
> &
    Partial<Pick<RuntimeEnvironment, "repositoryId">>;

/** A recipe Kodus inferred or Kody wrote: it lives here until a PR adds it to the repository. */
const generatedRecipe = (env: NextStepEnvironment) => {
    const recipe = env.setup?.recipe;
    return recipe?.origin === "inferred" || recipe?.origin === "authored"
        ? recipe
        : undefined;
};

/**
 * The one thing to do next on the environment page, for every state: what
 * the page answers first, before any section. Each state has one action at
 * most; the sections below carry the rest.
 */
export const environmentNextStep = (
    env: NextStepEnvironment,
    /** The org's environments: one known only from earlier Runs points to its repository's managed one. */
    environments: readonly EnvironmentRef[] = [],
): EnvironmentNextStep => {
    const link = (
        label: string,
        section: (typeof ENVIRONMENT_SECTION)[keyof typeof ENVIRONMENT_SECTION],
    ): NextStepAction => ({
        kind: "link",
        label,
        href: `#${section}`,
    });

    // No product row: every setup and settings route answers 404 for it.
    if (isRunOnlyEnvironment(env)) {
        const managed =
            env.repositoryId !== undefined
                ? managedEnvironmentOf(
                      {
                          environmentId: env.environmentId,
                          repositoryId: env.repositoryId,
                      },
                      environments,
                  )
                : undefined;
        return {
            tone: "neutral",
            title: "From earlier Runs",
            detail: managed
                ? "Kodus knows this environment only from Runs that came before it was set up here. Its repository's environment is the one to set up and change."
                : "Kodus knows this environment only from earlier Runs. There is nothing to set up or change here.",
            ...(managed
                ? {
                      action: {
                          kind: "link" as const,
                          label: "Open its environment",
                          href: environmentHref(managed.environmentId),
                      },
                  }
                : {}),
        };
    }

    if (isEnvironmentBusy(env))
        return {
            tone: "info",
            title: "Setting up",
            detail: "Kody is booting the app on a clean machine. It takes a few minutes; this page updates by itself.",
            action: link("Watch the steps", ENVIRONMENT_SECTION.setup),
        };

    if (isNotSetUp(env))
        return {
            tone: "neutral",
            title: "Not set up yet",
            detail: "Kody reads the repository, works out how to build and start the app, and boots it on a clean machine. Nothing runs on your pull requests until it is set up.",
            action: { kind: "setup" },
        };

    const setup = env.setup;
    if (env.state === "blocked") {
        const blockers = setup?.blockers ?? [];
        const missing = blockers.filter((b) => b.kind === "missing_env").length;
        const first = blockers[0];
        if (missing)
            return {
                tone: "warning",
                title: `Needs ${missing} secret${missing === 1 ? "" : "s"}`,
                detail: "The app needs values Kody does not have. The blocker says which; add them and set up again.",
                action: link("Open the blocker", ENVIRONMENT_SECTION.blockers),
            };
        // Nothing booted and nothing to change: it waits for the day's reset.
        const outOfMinutes = machineMinutesBlockerWords(first);
        if (outOfMinutes)
            return {
                tone: "warning",
                title: "Out of machine minutes today",
                detail: outOfMinutes,
            };
        if (setup?.recipe?.inference || first?.kind === "no_recipe")
            return {
                tone: "warning",
                title: "No setup file yet",
                detail: "Kody could not work out how to build and start this app. Pick one of the ways below to add the setup file.",
                // The "No recipe yet" card, with its ways out, needs what
                // Kodus found; without it the blocker card carries the fix.
                action: setup?.recipe?.inference
                    ? link("Add a setup file", ENVIRONMENT_SECTION.recipe)
                    : link("Open the blocker", ENVIRONMENT_SECTION.blockers),
            };
        if (first?.kind === "cell_unavailable")
            return {
                tone: "warning",
                title: "No machine connected",
                detail: "Nothing booted: no machine was connected to take the setup.",
                action: {
                    kind: "link",
                    label: "Go to hosts",
                    href: `/runtime/environments#${CELLS_SECTION_ID}`,
                },
            };
        if (first?.kind === "capacity")
            return {
                tone: "warning",
                title: "No suitable machine",
                detail: NO_SUITABLE_CELL,
                action: {
                    kind: "link",
                    label: "Go to hosts",
                    href: `/runtime/environments#${CELLS_SECTION_ID}`,
                },
            };
        const proven = setup?.learn?.proven;
        if (
            setup?.recipe?.origin === "inferred" &&
            proven?.origin === "inferred" &&
            proven.content &&
            proven.cleanBoots >= INFERRED_RECIPE_CLEAN_BOOTS
        )
            return {
                tone: "info",
                title: "Kody found a fix for the setup file",
                detail: `With one change (${proven.fix.label}) it booted from zero twice. Open the pull request that adds it to the repository.`,
                action: link(
                    "Review the setup file",
                    ENVIRONMENT_SECTION.recipe,
                ),
            };
        if (first?.kind === "recipe_invalid")
            return {
                tone: "warning",
                title: "The setup file is invalid",
                detail: first.message,
                action: link("See what is wrong", ENVIRONMENT_SECTION.setup),
            };
        // A recipe Kody wrote that did not boot: the next setup hands this
        // failure back to Kody, which rewrites the recipe from it. A setup
        // that stopped before the recipe had its chance keeps the recipe.
        if (setup?.recipe?.origin === "authored")
            return isRecipeFailureBlocker(first)
                ? {
                      tone: "danger",
                      title: "The setup file Kody wrote did not boot",
                      detail: `${plainBootFailure(first?.message) ?? "The app did not boot."} Set up again: Kody rewrites the setup file from this failure.`,
                      action: { kind: "setup" },
                  }
                : {
                      tone: "warning",
                      title: "The setup stopped before the setup file could boot",
                      detail: `${first?.message ?? "Kodus could not boot the app."} Nothing in the setup file Kody wrote failed: set up again and it boots the same setup file.`,
                      action: { kind: "setup" },
                  };
        return {
            tone: "danger",
            title: "The last setup failed",
            detail:
                plainBootFailure(first?.message) ??
                "The app did not boot. The blockers say why and how to fix it.",
            action: link("Open the blocker", ENVIRONMENT_SECTION.blockers),
        };
    }

    const generated = generatedRecipe(env);
    if (generated && setup?.state === "active") {
        if ((generated.cleanBoots ?? 0) < INFERRED_RECIPE_CLEAN_BOOTS)
            return {
                tone: "info",
                title: "Ready, setup file not proven yet",
                detail: "It booted once with the setup file Kody wrote. Set up again to prove it boots from zero, then add it to the repository.",
                action: { kind: "setup" },
            };
        return {
            tone: "success",
            title: "Ready: add the setup file to the repository",
            detail: "It booted from zero twice. Open the pull request that adds .kodus/workspace.yaml, so it lives with the code.",
            action: link("Review the setup file", ENVIRONMENT_SECTION.recipe),
        };
    }

    return {
        tone: "success",
        title: "Ready",
        detail: "Kody boots this app for every pull request it tests. Try it on past pull requests first: nothing is posted on them.",
        action: link("Simulate on past PRs", ENVIRONMENT_SECTION.simulation),
    };
};

/**
 * Where the e2e suite block of a setup file Kody wrote came from: the comment
 * the recipe author puts above it (libs/runtime/api/application/recipe-author/
 * suite-block.ts), read from the file's text. Null when the block was not
 * inferred from the repository's CI (the team wrote it, or there is none).
 */
export function inferredSuiteOrigin(
    content: string | undefined,
): { file: string; job: string } | null {
    const m = content?.match(
        /^# suite: origin inferred from (\S+) job (\S+?);/m,
    );
    return m ? { file: m[1], job: m[2] } : null;
}
