/**
 * What the agent page says about failing runs and files its dropped findings
 * cited without following them.
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import { agentStatusLine, citationCandidates, runProblem } from "./drafts";
import type { CustomAgent, CustomAgentStatus } from "./types";

const RULES = "greenhouse/irrigation-rules";
const agent = {
    scope: { include: ["src/valves/**"] },
    enabled: true,
} as Pick<CustomAgent, "scope" | "enabled">;
const health = (
    over: Partial<NonNullable<CustomAgentStatus["health"]>> = {},
    last: Partial<NonNullable<CustomAgentStatus["health"]>["last"]> = {},
): NonNullable<CustomAgentStatus["health"]> => ({
    runs: 5,
    failedPullRequests: 3,
    streak: 3,
    ...over,
    last: {
        status: "failed",
        reason: "MODEL_ACCESS_DENIED (HTTP 403)",
        at: "2026-10-30T10:00:00.000Z",
        prNumber: 12,
        ...last,
    },
});

describe("runProblem", () => {
    it("says how many runs in a row failed, why, and that the model fixes it", () => {
        expect(runProblem(health())).toEqual({
            tone: "danger",
            title: "The last 3 runs failed",
            detail: "Your AI provider account can't use the model it is set to.",
            action: "model",
        });
    });

    it("points a key or credit problem at the AI providers", () => {
        expect(
            runProblem(
                health({ streak: 1 }, { reason: "QUOTA_EXCEEDED (HTTP 429)" }),
            ),
        ).toMatchObject({
            title: "The last run failed",
            action: "providers",
        });
    });

    it("tells a run that stopped short apart from one that failed", () => {
        expect(
            runProblem(
                health(
                    { streak: 2 },
                    { status: "incomplete", reason: "max-steps" },
                ),
            ),
        ).toEqual({
            tone: "warning",
            title: "The last 2 runs stopped before finishing",
            detail: "It hit its step limit before finishing. Narrower files or instructions help.",
        });
    });

    it("says nothing once the newest run finished, or for an unknown reason offers no fix", () => {
        expect(runProblem(health({ streak: 0 }, { status: "ran" }))).toBeNull();
        expect(runProblem(undefined)).toBeNull();
        expect(runProblem(health({}, { reason: "UNKNOWN" }))).toEqual({
            tone: "danger",
            title: "The last 3 runs failed",
            detail: "The run failed before posting anything.",
        });
    });
});

describe("agentStatusLine with runs", () => {
    it("says runs posted nothing instead of no findings when they failed", () => {
        expect(
            agentStatusLine(
                agent,
                {
                    agentId: "valves",
                    pullRequests: 0,
                    posted: 0,
                    dropped: 0,
                    health: health(),
                },
                30,
            ),
        ).toBe(
            "Runs on src/valves/** · 5 runs, nothing posted · failed on 3 PRs in 30 days",
        );
    });

    it("adds the failed pull requests to an agent that also posted", () => {
        expect(
            agentStatusLine(
                agent,
                {
                    agentId: "valves",
                    pullRequests: 4,
                    posted: 6,
                    dropped: 1,
                    health: health({ failedPullRequests: 1 }),
                },
                30,
            ),
        ).toBe(
            "Runs on src/valves/** · 4 PRs · 6 posted · failed on 1 PR in 30 days",
        );
    });
});

describe("citationCandidates", () => {
    it("reads repo/path and owner/repo/path as a file of that repository", () => {
        expect(
            citationCandidates("irrigation-rules/stack/node/valves.md", [
                RULES,
            ])[0],
        ).toEqual({
            path: "stack/node/valves.md",
            kind: "doc",
            repository: RULES,
        });
        expect(
            citationCandidates(`${RULES}/stack/node/valves.md`, [RULES])[0],
        ).toEqual({
            path: "stack/node/valves.md",
            kind: "doc",
            repository: RULES,
        });
    });

    it("tries a bare path here first, then in each repository", () => {
        expect(citationCandidates("stack/node/valves.md", [RULES])).toEqual([
            { path: "stack/node/valves.md", kind: "doc" },
            { path: "stack/node/valves.md", kind: "doc", repository: RULES },
        ]);
    });

    it("names one file for owner/repo:path and offers a skill by its folder", () => {
        expect(
            citationCandidates(`${RULES}:skills/pumps/SKILL.md`, [RULES]),
        ).toEqual([{ path: "skills/pumps", kind: "skill", repository: RULES }]);
    });
});
