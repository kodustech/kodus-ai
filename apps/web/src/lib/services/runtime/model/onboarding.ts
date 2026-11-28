import type { RuntimeEnvironment } from "../contracts";
import { isEnvironmentBusy } from "./environment";

// The first run of the Environments screen: pick a repository, watch its
// first setup, test a pull request. The guide replaces the table while the
// organization has fewer than ONBOARDING_MAX_ENVIRONMENTS environments and
// has not tested a pull request yet: none is ready, or the ready one's
// repository has no Run. Past that the table says more than the guide.

/** With this many environments the table shows, ready or not. */
export const ONBOARDING_MAX_ENVIRONMENTS = 3;

type OnboardingEnvironment = Pick<
    RuntimeEnvironment,
    "environmentId" | "repositoryId" | "repositoryName" | "state" | "setup"
>;

/** Booted at least once and nothing newer pending: Runs can boot from it. */
export const isEnvironmentReady = (env: Pick<RuntimeEnvironment, "state" | "setup">) =>
    env.state === "active" && !!env.setup;

export type OnboardingStep = "pick" | "watch" | "test";

export type Onboarding<E extends OnboardingEnvironment> = {
    step: OnboardingStep;
    /** The environment step 2 and 3 talk about. */
    environment?: E;
    /** Step 2 only: the first setup stopped and needs someone. */
    blocked?: boolean;
};

/** The environment step 3 talks about: the first one Runs can boot from. */
export const firstReadyEnvironment = <E extends OnboardingEnvironment>(
    environments: readonly E[],
) => environments.find(isEnvironmentReady);

/**
 * The guide to show, or undefined for the table. `readyHasRuns` is whether
 * the ready environment's repository has a Run; while that is unknown
 * (loading, failed) the table shows, so an error never traps anyone here.
 */
export const onboardingState = <E extends OnboardingEnvironment>(
    environments: readonly E[],
    readyHasRuns?: boolean,
): Onboarding<E> | undefined => {
    if (environments.length >= ONBOARDING_MAX_ENVIRONMENTS) return undefined;
    const ready = firstReadyEnvironment(environments);
    if (ready)
        return readyHasRuns === false
            ? { step: "test", environment: ready }
            : undefined;
    if (!environments.length) return { step: "pick" };
    // The one still moving first; else the first, blocked or never booted.
    const environment =
        environments.find((e) => isEnvironmentBusy(e)) ?? environments[0];
    return {
        step: "watch",
        environment,
        blocked: environment.state === "blocked",
    };
};
