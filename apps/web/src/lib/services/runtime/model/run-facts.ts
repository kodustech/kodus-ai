import type { RunExercised, RuntimeRun } from "../contracts";
import type { RunStreamView } from "../stream";

// What forced a Run's check to neutral, as structured facts. The verdict
// event carries decideRunVerdict's `forcedNeutral` phrases (fixed templates
// in libs/runtime/run/run-state.ts, never model text) and the check title
// repeats them after " · ", so a Run whose stream expired still has them.
// Only the known templates are read; anything else is ignored.

export type RunFacts = {
    /** Outbound requests the sandbox blocked during the test. */
    blockedOutbound?: number;
    /** The diff changes a lockfile, Dockerfile, compose, CI or vendored code no probe exercised. */
    dependencyChangeUntested: boolean;
    /** The diff was cut to fit: what was cut is untested. */
    diffTruncated: boolean;
    /** Recipe files the PR changes whose PR copy the Run never boots: main's are used. */
    recipeChangedInPr: string[];
    /** Probes Kody wrote that the plan check refused before they ran, and why (the schema's messages). */
    rejectedProbes?: { count: number; reasons: string[] };
    /** How many of the PR's changed lines ran (the report's `exercised`); absent on older Runs. */
    exercised?: RunExercised["summary"];
};

const BLOCKED = /^(\d+) blocked outbound requests?$/;
const DEPENDENCY = "dependency change not behavior-tested";
const TRUNCATED = "diff too large to test whole";

/** The neutral reasons of the check title: everything after its first " · ". */
export const neutralReasonsOfTitle = (title: string | undefined) =>
    title ? title.split(" · ").slice(1) : [];

export const parseNeutralReasons = (
    reasons: readonly string[],
): Omit<RunFacts, "recipeChangedInPr" | "rejectedProbes"> => {
    const facts: Omit<RunFacts, "recipeChangedInPr" | "rejectedProbes"> = {
        dependencyChangeUntested: false,
        diffTruncated: false,
    };
    for (const raw of reasons) {
        const reason = raw.trim();
        const blocked = BLOCKED.exec(reason);
        if (blocked) facts.blockedOutbound = Number(blocked[1]);
        else if (reason === DEPENDENCY) facts.dependencyChangeUntested = true;
        else if (reason === TRUNCATED) facts.diffTruncated = true;
    }
    return facts;
};

export const runFacts = (
    run: Pick<RuntimeRun, "check" | "recipeChangedInPr" | "exercised">,
    view?: Pick<RunStreamView, "verdict">,
): RunFacts => ({
    ...parseNeutralReasons(
        view?.verdict?.forcedNeutral ??
            neutralReasonsOfTitle(
                view?.verdict?.check?.title ?? run.check?.title,
            ),
    ),
    recipeChangedInPr: run.recipeChangedInPr ?? [],
    ...(run.exercised ? { exercised: run.exercised.summary } : {}),
    ...(view?.verdict?.rejectedProbes
        ? {
              rejectedProbes: {
                  count: view.verdict.rejectedProbes,
                  reasons: (view.verdict.rejectedReasons ?? [])
                      .map((r) => r.trim().slice(0, 200))
                      .filter(Boolean)
                      .slice(0, 3),
              },
          }
        : {}),
});

/**
 * Where the setup file a Run booted with came from, in words: a recipe the developer's agent sent or Kody wrote is not
 * read from the base branch, and the Run page used to say it was. `base`: the base branch's name.
 */
export const runRecipeSource = (
    recipe: RuntimeRun["recipe"],
    base: string,
): string => {
    if (!recipe) return "The environment's setup file";
    if (recipe.state === "absent") return "No setup file";
    switch (recipe.origin) {
        case "submitted":
            return "Sent from a coding agent";
        case "authored":
            return "Written by Kody";
        case "inferred":
            return "Inferred by Kodus";
        default:
            return `Committed in ${base} at ${recipe.sha.slice(0, 7)}`;
    }
};
