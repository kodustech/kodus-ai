/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type {
    CustomAgent,
    CustomAgentResolveReport,
    CustomAgentStatus,
    KnowledgeItem,
} from "@services/custom-agents/types";
import { fireEvent, render, screen } from "@testing-library/react";

import { StatusStrip } from "./status-strip";
import { UnfollowedCitations } from "./unfollowed-citations";

/**
 * The agent page saying an agent is failing, and offering the files its
 * dropped findings cited.
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
const RULES = "greenhouse/irrigation-rules";
const mockResolve = jest.fn();
jest.mock("@services/custom-agents/hooks", () => ({
    useResolveCustomAgent: (params: unknown) => mockResolve(params),
}));

const agent = {
    id: "valves",
    name: "Valves",
    enabled: true,
    scope: { include: ["src/valves/**"] },
} as unknown as CustomAgent;
const failing: CustomAgentStatus = {
    agentId: "valves",
    pullRequests: 0,
    posted: 0,
    dropped: 0,
    health: {
        runs: 4,
        failedPullRequests: 3,
        streak: 3,
        last: {
            status: "failed",
            reason: "MODEL_NOT_FOUND (HTTP 404)",
            at: "2026-10-30T10:00:00.000Z",
            prNumber: 12,
        },
    },
};
const strip = (
    status: CustomAgentStatus,
    canEdit = true,
    runsUnavailable?: boolean,
) =>
    render(
        <StatusStrip
            agent={agent}
            status={status}
            runsUnavailable={runsUnavailable}
            windowDays={30}
            isLoading={false}
            isGlobal={false}
            canEdit={canEdit}
            onEnabledChange={jest.fn()}
        />,
    );

describe("StatusStrip with failing runs", () => {
    it("says the runs failed, why, and takes you to the model", () => {
        const model = document.createElement("button");
        model.id = "agent-model";
        model.scrollIntoView = jest.fn();
        document.body.appendChild(model);
        strip(failing);

        expect(screen.getByRole("status")).toHaveTextContent(
            "The last 3 runs failed",
        );
        expect(screen.getByRole("status")).toHaveTextContent(
            "The model it is set to no longer exists on your AI provider. Last on PR #12",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Change the model" }),
        );
        expect(model.scrollIntoView).toHaveBeenCalled();
        expect(document.activeElement).toBe(model);
        model.remove();
    });

    it("points a key problem at AI providers, even without edit rights", () => {
        strip(
            {
                ...failing,
                health: {
                    ...failing.health!,
                    last: {
                        ...failing.health!.last,
                        reason: "AUTH_INVALID (HTTP 401)",
                    },
                },
            },
            false,
        );

        expect(
            screen.getByRole("link", { name: "Open AI providers" }),
        ).toHaveAttribute("href", "/byok");
    });

    it("shows nothing once the newest run finished", () => {
        strip({
            ...failing,
            health: {
                ...failing.health!,
                streak: 0,
                last: { ...failing.health!.last, status: "ran" },
            },
        });

        expect(screen.queryByRole("status")).toBeNull();
    });

    it("says the runs could not be read instead of reading as a quiet, healthy agent", () => {
        const quiet = {
            agentId: "valves",
            pullRequests: 0,
            posted: 0,
            dropped: 0,
        };
        strip(quiet, true, true);

        expect(
            screen.getByText(
                "Could not read this agent's runs, so failed runs do not show here. Reload to try again.",
            ),
        ).toBeInTheDocument();
    });

    it("says nothing about the runs when they were read", () => {
        strip({ agentId: "valves", pullRequests: 0, posted: 0, dropped: 0 });

        expect(
            screen.queryByText(/Could not read this agent's runs/),
        ).toBeNull();
    });
});

describe("UnfollowedCitations", () => {
    const found = (
        items: Array<
            Pick<KnowledgeItem, "path" | "kind" | "repository"> & {
                kodyRuleSource?: boolean;
            }
        >,
    ) => ({
        isLoading: false,
        data: {
            knowledge: {
                status: "ok",
                items: items.map((item) => ({
                    found: true,
                    issues: [],
                    linkedTo: [],
                    kodyRuleSource: false,
                    ...item,
                })),
                budgets: [],
            },
        } as unknown as CustomAgentResolveReport,
    });
    const offer = (knowledge: KnowledgeItem[] = [], onFollow = jest.fn()) => {
        render(
            <UnfollowedCitations
                agentId="valves"
                citations={[
                    {
                        file: "irrigation-rules/stack/node/valves.md",
                        findings: 11,
                        pullRequests: 3,
                    },
                    {
                        file: "stack/node/valves.md",
                        findings: 6,
                        pullRequests: 2,
                    },
                    { file: "docs/missing.md", findings: 1, pullRequests: 1 },
                ]}
                knowledge={knowledge}
                repositories={[RULES]}
                canEdit
                teamId="team-1"
                repositoryId="repo-1"
                onFollow={onFollow}
            />,
        );
        return onFollow;
    };

    beforeEach(() => {
        mockResolve.mockReturnValue(
            found([
                {
                    path: "stack/node/valves.md",
                    kind: "doc",
                    repository: RULES,
                },
            ]),
        );
    });

    it("offers the file both citations name, checked to exist, as one row", () => {
        const onFollow = offer();

        expect(screen.getAllByRole("listitem")).toHaveLength(1);
        expect(
            screen.getByText("17 findings dropped · 3 PRs"),
        ).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", {
                name: `Follow ${RULES}:stack/node/valves.md`,
            }),
        );
        expect(onFollow).toHaveBeenCalledWith({
            path: "stack/node/valves.md",
            kind: "doc",
            repository: RULES,
        });
        // The check asked for every candidate once, linked to this agent.
        expect(mockResolve.mock.calls[0][0].knowledge).toEqual(
            expect.arrayContaining([
                {
                    path: "stack/node/valves.md",
                    kind: "doc",
                    repository: RULES,
                    linkedTo: [{ agentId: "valves" }],
                },
                {
                    path: "docs/missing.md",
                    kind: "doc",
                    linkedTo: [{ agentId: "valves" }],
                },
            ]),
        );
    });

    it("warns before following a file of this repository that also feeds Kody Rules", () => {
        // Only this repository's files feed Kody Rules; the check never
        // flags another repository's.
        mockResolve.mockReturnValue(
            found([
                {
                    path: "docs/missing.md",
                    kind: "doc",
                    kodyRuleSource: true,
                },
            ]),
        );
        offer();

        expect(
            screen.getByText("· Also a Kody Rules source"),
        ).toBeInTheDocument();
    });

    it("offers nothing the agent already follows, or nothing that exists", () => {
        offer([
            {
                path: "stack/node/valves.md",
                kind: "doc",
                repository: RULES,
                linkedTo: [{ agentId: "valves" }],
            },
        ]);
        expect(
            screen.queryByRole("region", { name: "Cited by dropped findings" }),
        ).toBeNull();
    });
});
