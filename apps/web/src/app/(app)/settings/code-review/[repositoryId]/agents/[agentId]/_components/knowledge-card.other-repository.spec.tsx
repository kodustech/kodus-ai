/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type {
    CustomAgentResolveReport,
    KnowledgeItem,
} from "@services/custom-agents/types";
import { fireEvent, render, screen } from "@testing-library/react";

import { AgentKnowledgeField } from "./knowledge-card";

/**
 * The agent's skills and docs from another repository (#2329).
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
const RULES = "greenhouse/irrigation-rules";
const mockResolve = jest.fn();
jest.mock("@services/custom-agents/hooks", () => ({
    useResolveCustomAgent: (params: { source?: { repository?: string } }) =>
        mockResolve(params),
}));

const report = (
    over: Partial<
        Extract<CustomAgentResolveReport["knowledge"], { status: "ok" }>
    > = {},
): CustomAgentResolveReport => ({
    repository: { id: "repo-1", name: "irrigation-service", branch: "main" },
    agentIssues: [],
    astGrep: { ruleCount: 0, ruleIds: [], errors: [] },
    mcp: { status: "unavailable", reason: "" },
    knowledge: {
        status: "ok",
        items: [],
        budgets: [],
        candidates: [],
        linkedRepositories: [RULES],
        repositoryVisibility: "public",
        ...over,
    },
});

const remoteListing = {
    isLoading: false,
    isFetching: false,
    data: report({
        candidates: [
            {
                path: "stack/node/rules/valves.md",
                kind: "doc",
                kodyRuleSource: false,
            },
        ],
        discoveredIn: {
            repository: RULES,
            branch: "trunk",
            visibility: "private",
            available: true,
        },
    }),
};

beforeEach(() => {
    mockResolve.mockImplementation((params) =>
        params?.listConnected && params.enabled !== false
            ? {
                  isLoading: false,
                  isFetching: false,
                  data: report({
                      connectedRepositories: [RULES, "greenhouse/dashboard"],
                  }),
              }
            : params?.source?.repository && params.enabled !== false
              ? remoteListing
              : { isLoading: false, isFetching: false, data: undefined },
    );
});

const field = (knowledge: KnowledgeItem[], onChange = jest.fn()) => {
    render(
        <AgentKnowledgeField
            agentId="valves"
            knowledge={knowledge}
            report={report()}
            canEdit
            onChange={onChange}
            teamId="team-1"
            repositoryId="repo-1"
            instructions="Read the rules in irrigation-rules before commenting."
        />,
    );
    return onChange;
};

describe("AgentKnowledgeField with another repository", () => {
    it("points out a linked repository the instructions name, and opens its rules", () => {
        const onChange = field([]);

        expect(screen.getByRole("note")).toHaveTextContent(
            `The instructions mention ${RULES}, but this agent follows nothing from it.`,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Browse its rules" }),
        );

        expect(
            screen.getByRole("button", {
                name: "irrigation-rules",
                pressed: true,
            }),
        ).toBeInTheDocument();
        expect(screen.getByText(/its default branch/)).toHaveTextContent(
            "Reading trunk, its default branch.",
        );
        expect(screen.getByText(/Private repository/)).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", {
                name: "Follow stack/node/rules/valves.md",
            }),
        );
        expect(onChange).toHaveBeenCalledWith([
            {
                path: "stack/node/rules/valves.md",
                kind: "doc",
                repository: RULES,
                linkedTo: [{ agentId: "valves" }],
            },
        ]);
    });

    it("names where a followed item lives and stops pointing out its repository", () => {
        field([
            {
                path: "stack/node/rules/valves.md",
                kind: "doc",
                repository: RULES,
                ref: "v3",
                linkedTo: [{ agentId: "valves" }],
            },
        ]);

        expect(screen.queryByRole("note")).toBeNull();
        expect(screen.getByText(`${RULES} · v3 (pinned)`)).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: `Stop following ${RULES}:stack/node/rules/valves.md`,
            }),
        ).toBeInTheDocument();
    });

    it("pins every item of the repository to the branch or tag typed", () => {
        const knowledge: KnowledgeItem[] = [
            {
                path: "a.md",
                kind: "doc",
                repository: RULES,
                linkedTo: [{ agentId: "valves" }],
            },
            { path: "b.md", kind: "doc", linkedTo: [{ agentId: "valves" }] },
        ];
        const onChange = field(knowledge);

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "irrigation-rules" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Use a branch or tag instead" }),
        );
        fireEvent.change(screen.getByLabelText(`Branch or tag of ${RULES}`), {
            target: { value: "v3" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Use" }));

        expect(onChange).toHaveBeenLastCalledWith([
            { ...knowledge[0], ref: "v3" },
            knowledge[1],
        ]);
    });

    it("says why a repository cannot be listed", () => {
        mockResolve.mockImplementation((params) =>
            params?.source?.repository
                ? {
                      isLoading: false,
                      isFetching: false,
                      data: report({
                          candidates: [],
                          discoveredIn: {
                              repository: RULES,
                              branch: "trunk",
                              available: false,
                              reason: `${RULES} is not a repository this team's integration can read.`,
                          },
                      }),
                  }
                : { isLoading: false, isFetching: false, data: undefined },
        );
        field([]);

        fireEvent.click(
            screen.getByRole("button", { name: "Browse its rules" }),
        );

        expect(
            screen.getByText(
                `${RULES} is not a repository this team's integration can read.`,
            ),
        ).toBeInTheDocument();
    });

    it("lists every connected repository under Other repository", () => {
        // The command list measures itself; jsdom has no ResizeObserver.
        globalThis.ResizeObserver ??= class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
        Element.prototype.scrollIntoView ??= jest.fn();
        field([]);

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Other repository…" }),
        );

        expect(screen.getByText("greenhouse/dashboard")).toBeInTheDocument();
    });
});
