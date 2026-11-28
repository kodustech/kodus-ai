import type { ForkPullRequestPolicy } from "../contracts";

// The web's copy of the fork policies (libs/runtime/contracts/enums.ts): the
// isolated web build imports runtime types only. fork-pull-requests.parity.spec.ts
// keeps the two in step.

export type ForkPolicyOption = {
    value: ForkPullRequestPolicy;
    label: string;
    hint: string;
};

export const FORK_POLICY_OPTIONS: readonly ForkPolicyOption[] = [
    {
        value: "require_approval",
        label: "Wait for a maintainer",
        hint: "The Run waits until someone with write access to the repository approves this head. A new push asks again.",
    },
    {
        value: "skip",
        label: "Don't run",
        hint: "Pull requests from forks get no Run.",
    },
    {
        value: "run",
        label: "Run without approval",
        hint: "Anyone who opens a pull request from a fork runs their code on your machines. Only for repositories where every contributor is trusted.",
    },
];

/** What the API answers when it has never saved a policy. */
export const DEFAULT_FORK_POLICY: ForkPullRequestPolicy = "require_approval";

export const forkPolicyOption = (value: string) =>
    FORK_POLICY_OPTIONS.find((o) => o.value === value);

/**
 * Why pull requests from forks wait for a maintainer although the environment
 * is set otherwise (`effectiveForkPullRequests`: `run` reads as
 * `require_approval` in an environment of several repositories); undefined
 * when the stored policy is the one that applies.
 */
export const heldForkPolicyNote = (
    setting: ForkPullRequestPolicy,
    effective: ForkPullRequestPolicy | undefined,
): string | undefined => {
    if (!effective || effective === setting) return undefined;
    return "Pull requests from forks still wait for a maintainer: this environment holds several repositories, and a fork's code would run on a machine that holds the other repositories' code too.";
};
