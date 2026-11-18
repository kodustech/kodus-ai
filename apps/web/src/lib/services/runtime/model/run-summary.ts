import type { RunState, RuntimeRun, RunUncovered } from "../contracts";
import { isFailingOutcome } from "../labels";
import { baseVersionLabel } from "./base-version";
import { bootFailureDetailOf, isKodusSideBootFailure, timedOutForCapacity } from "./boot-failure";
import { capacityWaitSentence } from "./capacity-wait";
import { ENVIRONMENT_SECTION, environmentHref } from "./environment";
import type { Finding } from "./findings";
import { firstRegressionOfFinding, regressionSentence } from "./pull-request-runs";
import { code, codeList, type RichText } from "./rich-text";
import type { RunFacts } from "./run-facts";
import type { RunPaths } from "./run-paths";

// The verdict card: one headline per state, a plain explanation and what the
// developer can do. Every sentence is built from structured fields (paths,
// uncovered reasons, blockers, recipe and neutral facts); no text from the
// agent or the app reaches it.

/**
 * The one thing the verdict card offers to do, by state; the page wires it.
 * A `link` in `todo` is the action when there is no other.
 */
export type RunAction =
    | { kind: "run_again" }
    | { kind: "mark_intended"; probeId: string }
    | { kind: "open_finding"; probeId: string };

export type RunSummary = {
    headline: string;
    explanation: RichText[];
    /** How sure Kody is of a regression: "Same answer in 2 of 2 attempts on each side". */
    certainty?: string;
    /** The explanation already says the PR's setup file change was not tested: the page does not repeat it. */
    saysSetupFileChange?: true;
    /** Retains a recorded result when a later error interrupts the Run. */
    hasRecordedVerdict?: boolean;
    /** Whether a historical success still has completed comparisons to inspect. */
    hasRecordedComparisons?: boolean;
    /** "What you can do"; absent while there is nothing to do yet. */
    todo?: {
        text: RichText;
        link?: { href: string; label: string };
        action?: RunAction;
    };
};

const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;

const environmentLink = (environmentId: string, label: string) => ({
    href: `/runtime/environments/${encodeURIComponent(environmentId)}`,
    label,
});

const setupFileLink = (environmentId: string) => ({
    href: environmentHref(environmentId, ENVIRONMENT_SECTION.recipe),
    label: "Open the setup file",
});

const RUN_AGAIN = { kind: "run_again" } as const;

const RUN_AGAIN_TODO: RichText = [
    "Run again. If it fails the same way, share this Run link with support.",
];

/** "Same answer in 2 of 2 attempts on each side", from what each side answered round by round. */
const certaintyOf = (
    f: Pick<Finding, "base" | "pr">,
    baseLabel: string,
): string | undefined => {
    const finished = (rounds: Finding["base"]["rounds"]) =>
        rounds.filter(
            (r) => r.answer !== "running" && r.answer !== "not recorded",
        );
    const base = finished(f.base.rounds);
    const pr = finished(f.pr.rounds);
    if (!base.length || !pr.length) return undefined;
    if (!f.base.steady || !f.pr.steady)
        return "The answer changed between attempts: read the evidence before acting on it";
    if (base.length === pr.length)
        return `Same answer in ${base.length} of ${f.base.rounds.length} attempts on each side`;
    return `Same answer in every attempt: ${base.length} on ${baseLabel}, ${pr.length} on this PR`;
};

const LIVE: Partial<Record<RunState, RunSummary>> = {
    queued: {
        headline: "Waiting for a free machine",
        explanation: [
            [
                "The Run is queued until a machine is free. Kody starts as soon as one takes it; nothing has run yet.",
            ],
        ],
    },
    awaiting_approval: {
        headline: "Waiting for a maintainer to approve this Run",
        explanation: [
            [
                "This pull request comes from a fork, so its code runs only after someone with write access approves it.",
            ],
        ],
    },
};

const ENDED: Partial<Record<RunState, RunSummary>> = {
    skipped: {
        headline: "Kody did not run on this PR",
        explanation: [["Nothing was booted or compared."]],
    },
    superseded: {
        headline: "A newer push replaced this Run",
        explanation: [
            [
                "The pull request moved on before this Run finished; the newer Run has the verdict.",
            ],
        ],
    },
    cancelled: {
        headline: "This Run was cancelled",
        explanation: [["It stopped before a verdict."]],
    },
    timed_out: {
        headline: "This Run hit its time limit before a verdict",
        explanation: [["Nothing it measured counts as a verdict."]],
    },
    halted: {
        headline: "Kody stopped this Run: a security event",
        explanation: [
            [
                "The machine saw code from either version reach for something it must not. The machines were destroyed.",
            ],
        ],
    },
};

/**
 * "Changed lines exercised: 3 of 10.", with ", below the 50% this repo asks"
 * when fewer than the Run's threshold ran (the rule of decideRunVerdict,
 * libs/runtime/run/exercised-lines.ts), or why it was not measured; nothing
 * on a Run whose report predates it.
 */
const exercisedSentence = (
    exercised: RunFacts["exercised"],
): RichText | undefined => {
    if (!exercised) return undefined;
    if (exercised.measured) {
        const below =
            exercised.changed > 0 &&
            exercised.exercised / exercised.changed < exercised.threshold;
        return [
            `Changed lines exercised: ${exercised.exercised} of ${exercised.changed}${below ? `, below the ${Math.round(exercised.threshold * 100)}% this repo asks` : ""}.`,
        ];
    }
    return [
        exercised.language
            ? `Changed lines exercised: not measured for ${exercised.language}.`
            : "Changed lines exercised: not measured.",
    ];
};

/** The neutral facts, one sentence each, in the order a reader weighs them. */
export const factSentences = (facts: RunFacts): RichText[] => {
    const out: RichText[] = [];
    const exercised = exercisedSentence(facts.exercised);
    if (exercised) out.push(exercised);
    const rejected = facts.rejectedProbes;
    if (rejected?.count) {
        const reasons = rejected.reasons;
        out.push([
            `Kody wrote ${plural(rejected.count, "check")} that the plan validation refused before ${rejected.count === 1 ? "it" : "they"} ran`,
            ...(reasons.length ? [": ", ...codeList(reasons)] : []),
            ".",
        ]);
    }
    if (facts.recipeChangedInPr.length)
        out.push([
            "This PR changes ",
            ...codeList(facts.recipeChangedInPr),
            ", but Kody boots every pull request with the environment's recorded setup file, so that change was not tested.",
        ]);
    if (facts.dependencyChangeUntested)
        out.push([
            "This PR changes dependencies, a Dockerfile, compose or CI files that no check exercised.",
        ]);
    if (facts.blockedOutbound)
        out.push([
            `The app tried ${plural(facts.blockedOutbound, "outbound request")} that the sandbox blocked, so the check stays neutral.`,
        ]);
    if (facts.diffTruncated)
        out.push([
            "The diff was too large to test whole: what was cut is untested.",
        ]);
    return out;
};

const untestedSentence = (
    entryPoints: string[],
    uncovered: RunUncovered[] | undefined,
): RichText | undefined => {
    if (!entryPoints.length) return undefined;
    const blocked = (uncovered ?? []).filter(
        (u) => u.reason === "blocker" && entryPoints.includes(u.entryPoint),
    );
    if (blocked.length === entryPoints.length)
        return ["Not tested, blocked: ", ...codeList(entryPoints), "."];
    return [
        "Not tested: ",
        ...codeList(entryPoints),
        ": no check reached ",
        entryPoints.length === 1 ? "it." : "them.",
    ];
};

/** The variables untested paths need, from the blockers (never a value). */
export const missingVariables = (uncovered: RunUncovered[] | undefined) => [
    ...new Set(
        (uncovered ?? [])
            .filter((u) => u.blocker?.kind === "missing_env" && u.blocker.name)
            .map((u) => u.blocker!.name!),
    ),
];

const SETUP_FILE_CHANGE = "recorded setup file, so that change was not tested";

/** The verdict card's words for a Run; see summaryFor. */
export const runSummary = (
    ...args: Parameters<typeof summaryFor>
): RunSummary => {
    const summary = summaryFor(...args);
    const says = summary.explanation.some((sentence) =>
        sentence.some(
            (part) =>
                typeof part === "string" && part.includes(SETUP_FILE_CHANGE),
        ),
    );
    return says ? { ...summary, saysSetupFileChange: true } : summary;
};

const summaryFor = (
    run: Pick<
        RuntimeRun,
        "state" | "environmentId" | "uncovered" | "verdictState" | "baseBranch"
    > &
        Partial<Pick<RuntimeRun, "bootFailure" | "bootFailureDetail" | "noRuntimeEffect" | "phase" | "capacityWait">>,
    runPaths: Pick<
        RunPaths,
        "paths" | "untested" | "testedCount" | "totalCount"
    > &
        Partial<Pick<RunPaths, "coverageKnown">>,
    findings: (Pick<Finding, "entryPoint" | "intended" | "base" | "pr"> &
        Partial<
            Pick<
                Finding,
                | "boot"
                | "route"
                | "purpose"
                | "responseDiff"
                | "differingFields"
                | "destabilizes"
                | "newEndpoint"
                | "probeId"
                | "matchesExpectation"
                | "markedIntended"
            >
        >)[],
    facts: RunFacts,
): RunSummary => {
    const baseLabel = baseVersionLabel(run);
    if (run.state === "booting" && run.phase === "capacity")
        return {
            headline: "Waiting for a host",
            explanation: [
                [
                    `${capacityWaitSentence(run.capacityWait) ?? "Every host that can run this environment is busy."} Kody starts as soon as one has room; nothing has run yet.`,
                ],
            ],
        };
    if (run.state === "timed_out" && timedOutForCapacity(run))
        return {
            headline: "No host had room for this Run",
            explanation: [
                [
                    `It waited for a host and none had room. ${capacityWaitSentence(run.capacityWait) ?? "Every host that can run this environment is busy."}`,
                ],
                ["Nothing was booted or compared."],
            ],
            todo: {
                text: [
                    "Run again once other Runs finish, or register a host of your own under Hosts.",
                ],
                action: RUN_AGAIN,
            },
        };
    if (run.state === "booting")
        return {
            headline: `Booting ${baseLabel} and this PR`,
            explanation: [
                [
                    `Kody boots ${baseLabel} and this pull request side by side, on separate machines, before it sends them anything.`,
                ],
            ],
        };
    if (run.state === "testing")
        return {
            headline: `Testing this PR against ${baseLabel}`,
            explanation: [
                [
                    `Kody sends the same requests to ${baseLabel} and to this pull request and compares the answers.`,
                ],
            ],
        };
    const live = LIVE[run.state];
    if (live) return live;

    const regressions = findings.filter((f) => !f.intended);
    const intended = findings.filter((f) => f.intended);
    const untested = [
        ...runPaths.paths
            .filter((p) => p.outcome === "could_not_test")
            .map((p) => p.entryPoint),
        ...runPaths.untested.map((u) => u.entryPoint),
    ];
    const uniqueUntested = [...new Set(untested)];
    const changed = new Set(
        runPaths.paths
            .filter(
                (path) =>
                    !path.outsideDiff &&
                    (isFailingOutcome(path.outcome) ||
                        path.outcome === "intended" ||
                        path.outcome === "new_endpoint"),
            )
            .map((path) => path.entryPoint),
    );
    const sameCount = new Set(
        runPaths.paths
            .filter(
                (path) =>
                    !path.outsideDiff &&
                    !changed.has(path.entryPoint) &&
                    (path.outcome === "same" ||
                        path.outcome === "pre_existing"),
            )
            .map((path) => path.entryPoint),
    ).size;
    // Routes this PR adds that main does not have: new behavior, never counted as the same or as a regression.
    const newEndpoints = [
        ...new Set(
            runPaths.paths
                .filter((p) => p.outcome === "new_endpoint")
                .map((p) => p.route),
        ),
    ];
    const newEndpointsLine: RichText[] = newEndpoints.length
        ? [
              [
                  `New ${newEndpoints.length === 1 ? "endpoint" : "endpoints"} this PR adds, which ${baseLabel} does not have: `,
                  ...codeList(newEndpoints),
                  ". New behavior, not a regression.",
              ],
          ]
        : [];
    const preExistingOnly = [
        ...new Set(
            (run.uncovered ?? [])
                .filter((u) => u.reason === "pre_existing")
                .map((u) => u.entryPoint),
        ),
    ];
    const variables = missingVariables(run.uncovered);
    const facts$ = factSentences(facts);
    const coverTodo = (): RunSummary["todo"] =>
        variables.length
            ? {
                  text: [
                      "Add ",
                      ...codeList(variables),
                      " to the environment, then run again to cover what was blocked.",
                  ],
                  link: environmentLink(
                      run.environmentId,
                      "Open the environment",
                  ),
              }
            : uniqueUntested.length
              ? {
                    text: [
                        runPaths.testedCount > 0 && preExistingOnly.length === 0
                            ? "Nothing is needed for what was tested. To cover "
                            : "To test ",
                        ...codeList(uniqueUntested.slice(0, 3)),
                        uniqueUntested.length > 3 ? " and the rest" : "",
                        " next time, point Kody at a test or an HTTP path that runs it in ",
                        code(".kodus/workspace.yaml"),
                        ".",
                    ],
                }
              : undefined;

    const state = run.state;
    switch (state) {
        case "errored": {
            const hasRecordedVerdict =
                findings.length > 0 ||
                runPaths.testedCount > 0 ||
                run.verdictState === "regression" ||
                run.verdictState === "no_regressions";
            return {
                headline: "This Run could not finish",
                hasRecordedVerdict,
                explanation: [
                    [
                        hasRecordedVerdict
                            ? "The comparison did not finish. Recorded check results remain available below; the remaining paths have no verdict."
                            : "The comparison did not finish. No verdict was reached.",
                    ],
                ],
                todo: {
                    text: [
                        "Run again. If it keeps failing, share this Run link with support.",
                    ],
                    action: RUN_AGAIN,
                },
            };
        }
        case "regression": {
            // The verdict counted a regression the record does not carry (a
            // Run read before its projection caught up): never "0 paths".
            if (regressions.length === 0)
                return {
                    headline: "Kody found a regression on this PR",
                    explanation: [
                        [
                            "This Run's record does not carry the finding yet, so this page cannot show the request and both answers. Kody's comment on the pull request has what it measured.",
                        ],
                        ...facts$,
                    ],
                    todo: {
                        text: [
                            "Open the PR to read Kody's comment, or reload this page in a moment.",
                        ],
                    },
                };
            const first = regressions[0];
            const openFirst = first?.probeId
                ? {
                      action: {
                          kind: "open_finding" as const,
                          probeId: first.probeId,
                      },
                  }
                : {};
            const certainty = first ? certaintyOf(first, baseLabel) : undefined;
            // Only routes this PR adds fail: a finding on the new code, not a difference from main.
            if (regressions.every((f) => f.newEndpoint)) {
                const routes = [
                    ...new Set(regressions.map((f) => f.route ?? f.entryPoint)),
                ];
                return {
                    headline:
                        routes.length === 1
                            ? "A route this PR adds fails"
                            : `${routes.length} routes this PR adds fail`,
                    explanation: [
                        regressions.length === 1 && first
                            ? [
                                  code(routes[0]!),
                                  " answered ",
                                  code(first.pr.answer),
                                  ` on this PR. ${baseLabel} has no such route, so this is a finding on the new code, not a regression against ${baseLabel}.`,
                              ]
                            : [
                                  ...codeList(routes),
                                  ` fail on this PR. ${baseLabel} has no such routes, so these are findings on the new code, not regressions against ${baseLabel}.`,
                              ],
                        ...newEndpointsLine,
                        ...facts$,
                    ],
                    todo: {
                        text: [
                            "Open the finding below: it has the request and what this PR answered. Fix the new route, then push again.",
                        ],
                        ...openFirst,
                    },
                };
            }
            if (regressions.length === 1 && first?.boot) {
                const boot = bootFailureDetailOf(run);
                if (isKodusSideBootFailure(boot))
                    return {
                        headline: `This PR does not boot, and ${baseLabel} does`,
                        explanation: [
                            [
                                `${baseLabel[0].toUpperCase()}${baseLabel.slice(1)} booted and this PR did not: ${boot!.title.trim().replace(/\.$/, "")}. No path was compared.`,
                            ],
                            ...facts$,
                        ],
                        todo: {
                            text: [
                                "The boot failed on Kodus's side, not in this PR. Run again; if it fails the same way, share this Run link with support.",
                            ],
                            action: RUN_AGAIN,
                        },
                    };
                return {
                    headline: `This PR does not boot, and ${baseLabel} does`,
                    explanation: [
                        boot?.side === "pr"
                            ? [
                                  `Main booted and this PR did not: ${boot.title.trim().replace(/\.$/, "")}. No path was compared.`,
                              ]
                            : [
                                  "Main booted and this PR did not, so no path was compared.",
                              ],
                        ...facts$,
                    ],
                    todo: {
                        text: [
                            boot?.side === "pr"
                                ? "Read the boot log below, fix the build or the start of the app in this PR, then push again."
                                : "Boot this PR locally to see why it does not start, fix it, then push again.",
                        ],
                    },
                };
            }
            // Only new behavior the PR announced (the answer it expected, on a
            // route main does not have): the reader confirms it is intended.
            if (first?.matchesExpectation) {
                const announced = regressions.filter(
                    (f) => f.matchesExpectation,
                );
                const unmarked = announced.find((f) => !f.markedIntended);
                const explanation: RichText[] = [
                    [
                        code(first.route ?? first.entryPoint),
                        ` answered ${first.pr.answer} on this PR, as Kody expected before running; ${baseLabel} answered ${first.base.answer} because it has no such route. Confirm it is intended.`,
                    ],
                ];
                if (announced.length > 1)
                    explanation.push([
                        `${plural(announced.length - 1, "other path")} ${announced.length === 2 ? "is" : "are"} new in the same way: `,
                        ...codeList(
                            announced
                                .slice(1)
                                .map((f) => f.route ?? f.entryPoint),
                        ),
                        ".",
                    ]);
                if (sameCount)
                    explanation.push([
                        sameCount === 1
                            ? "The other tested path behaves the same."
                            : `The other ${sameCount} tested paths behave the same.`,
                    ]);
                const u = untestedSentence(uniqueUntested, run.uncovered);
                if (u) explanation.push(u);
                explanation.push(...facts$);
                return {
                    headline:
                        announced.length === 1
                            ? "New behavior that matches what this PR says it does"
                            : `${announced.length} new behaviors that match what this PR says it does`,
                    explanation,
                    ...(certainty ? { certainty } : {}),
                    todo: unmarked?.probeId
                        ? {
                              text: [
                                  "Confirm the change is intended: Kody learns from it. The check and the PR comment keep what Kody measured.",
                              ],
                              action: {
                                  kind: "mark_intended",
                                  probeId: unmarked.probeId,
                              },
                          }
                        : {
                              text: [
                                  "Marked as intended. Kody learns from it; the check and the PR comment keep what Kody measured.",
                              ],
                          },
                };
            }
            // One finding: the sentence the PR list says about it, from what
            // the probe checked and what differs; never its id or entry point.
            const headline =
                regressions.length === 1 && first
                    ? regressionSentence(
                          firstRegressionOfFinding(first),
                          baseLabel,
                      )
                    : new Set(regressions.map((r) => r.route)).size === 1
                      ? `${plural(regressions.length, "check")} answer differently on ${regressions[0]!.route}`
                      : `${plural(regressions.length, "check")} answer differently on this PR`;
            const explanation: RichText[] = [];
            if (regressions.length === 1 && first) {
                const steady = first.base.steady && first.pr.steady;
                explanation.push([
                    "The same request got ",
                    code(first.base.answer),
                    ` on ${baseLabel} and `,
                    code(first.pr.answer),
                    ` on this PR${steady && first.pr.rounds.length > 1 ? ", on every attempt" : ""}.`,
                ]);
            } else if (regressions.length > 1) {
                explanation.push([
                    "Main and this PR answered differently on ",
                    ...codeList([
                        ...new Set(
                            regressions.map((f) => f.route ?? f.entryPoint),
                        ),
                    ]),
                    ".",
                ]);
            }
            if (sameCount)
                explanation.push([
                    sameCount === 1
                        ? "The other tested path behaves the same."
                        : `The other ${sameCount} tested paths behave the same.`,
                ]);
            const u = untestedSentence(uniqueUntested, run.uncovered);
            if (u) explanation.push(u);
            explanation.push(...facts$);
            return {
                headline,
                explanation,
                ...(certainty ? { certainty } : {}),
                todo: {
                    text: [
                        `Open the finding below: it has the request, what ${baseLabel} and this PR answered, and how to reproduce it. Fix it, or say why it is intended in the PR.`,
                    ],
                    ...openFirst,
                },
            };
        }
        case "no_regressions": {
            const hasRecordedComparisons = runPaths.paths.some(
                (path) => path.outcome !== "could_not_test",
            );
            const coverageNote: RichText[] =
                runPaths.coverageKnown === true
                    ? []
                    : [
                          [
                              "Coverage of all changed paths was not recorded. These results do not establish coverage of the whole PR.",
                          ],
                      ];
            if (!hasRecordedComparisons)
                return {
                    headline: "No comparison recorded",
                    hasRecordedComparisons: false,
                    explanation: [
                        [
                            "The available record contains no completed comparison. The historical check result is preserved, but this page cannot confirm what was compared.",
                        ],
                        ...coverageNote,
                        ...facts$,
                    ],
                    todo: {
                        text: [
                            "Review the available Run record and continue your usual code review. Run again if you need a recorded comparison.",
                        ],
                    },
                };
            return {
                headline: "No regressions in the recorded comparisons",
                hasRecordedComparisons: true,
                explanation: [
                    [
                        "Recorded comparisons found no regression. This result covers only the recorded checks.",
                    ],
                    ...newEndpointsLine,
                    ...(runPaths.testedCount === 0
                        ? [
                              [
                                  "The recorded comparisons do not cover a changed path of this PR.",
                              ],
                          ]
                        : []),
                    ...coverageNote,
                    ...facts$,
                ],
                todo: {
                    text: [
                        "Review the recorded comparisons and continue your usual code review.",
                    ],
                },
            };
        }
        case "partly_tested": {
            const tested = runPaths.testedCount;
            const headline =
                tested === 0
                    ? "Kody could not test any path of this PR"
                    : preExistingOnly.length
                      ? "Some paths still have existing failures"
                      : intended.length
                        ? "Only intended changes in what Kody could test"
                        : "No regressions in what Kody could test";
            const explanation: RichText[] = [];
            if (tested > 0)
                explanation.push([
                    `Kody booted ${baseLabel} and this PR side by side and sent the same requests to both. On ${sameCount} of ${plural(runPaths.totalCount, "path")} they answered the same.`,
                ]);
            if (intended.length)
                explanation.push([
                    "Changed, as the PR intends: ",
                    ...codeList(intended.map((f) => f.entryPoint)),
                    ".",
                ]);
            explanation.push(...newEndpointsLine);
            const u = untestedSentence(uniqueUntested, run.uncovered);
            if (u) explanation.push(u);
            if (preExistingOnly.length)
                explanation.push([
                    "The same failure was observed on both versions for ",
                    ...codeList(preExistingOnly),
                    ". These paths were exercised but could not be cleared.",
                ]);
            explanation.push(...facts$);
            const next = coverTodo();
            const todo = preExistingOnly.length
                ? {
                      ...next,
                      text: next
                          ? ([
                                "Investigate the existing failures. ",
                                ...next.text,
                            ] as RichText)
                          : ([
                                "Investigate the existing failures, then run again to finish checking these paths.",
                            ] as RichText),
                  }
                : next;
            return { headline, explanation, todo };
        }
        case "nothing_to_test": {
            const files = (run.noRuntimeEffect ?? []).map((f) => f.file);
            return {
                headline: "Nothing to test at runtime",
                explanation: [
                    files.length
                        ? [
                              "This PR does not change what the app does: Kody read ",
                              ...codeList(files),
                              " with a parser and found only comments, blank lines, layout or documentation.",
                          ]
                        : [
                              "This PR does not change what the app does: only comments, blank lines, layout or documentation.",
                          ],
                    ["Nothing was booted and no request was sent."],
                ],
                todo: {
                    text: ["Continue your usual code review."],
                },
            };
        }
        case "could_not_boot": {
            const boot = bootFailureDetailOf(run);
            // Kodus's own step failed: nothing for the developer to fix.
            if (boot && isKodusSideBootFailure(boot))
                return {
                    headline: "Kodus could not start this Run",
                    explanation: [
                        [
                            `${boot.title.trim().replace(/\.$/, "")}. The problem is on Kodus's side, not in your repository or its setup file. Nothing was compared.`,
                        ],
                        ...facts$,
                    ],
                    todo: { text: RUN_AGAIN_TODO, action: RUN_AGAIN },
                };
            return {
                headline: "Kody could not boot the app",
                explanation: [
                    boot
                        ? [
                              boot.side === "base" ? "Main" : "This PR",
                              ` did not get ready, so nothing was compared: ${boot.title.trim().replace(/\.$/, "")}. The log it left is below.`,
                          ]
                        : [
                              "Main or this PR did not get ready, so nothing was compared.",
                          ],
                    ...facts$,
                ],
                todo: {
                    text: [
                        "See what stopped the boot below, fix it in the setup file or the repository, then run again.",
                    ],
                    link: setupFileLink(run.environmentId),
                },
            };
        }
        default: {
            const ended = ENDED[state];
            if (ended)
                return {
                    ...ended,
                    todo:
                        state === "timed_out"
                            ? {
                                  text: [
                                      "Run again. If it keeps failing, look at the environment.",
                                  ],
                                  link: environmentLink(
                                      run.environmentId,
                                      "Open the environment",
                                  ),
                                  action: RUN_AGAIN,
                              }
                            : undefined,
                };
            return { headline: "This Run ended", explanation: [] };
        }
    }
};

export type RunStats = {
    regressions: number;
    tested: number;
    total: number;
    tookMs?: number;
};

export const runStats = (
    runPaths: Pick<RunPaths, "paths" | "testedCount" | "totalCount">,
    totalMs: number | undefined,
): RunStats => ({
    regressions: runPaths.paths.filter((p) => isFailingOutcome(p.outcome))
        .length,
    tested: runPaths.testedCount,
    total: runPaths.totalCount,
    tookMs: totalMs,
});
