/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type {
    CustomAgentResolveReport,
    KnowledgeItem,
} from "@services/custom-agents/types";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";

import {
    AgentKnowledgeField,
    useKnowledgeSourceListing,
} from "./knowledge-card";

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

const field = (
    knowledge: KnowledgeItem[],
    onChange = jest.fn(),
    over: {
        canEdit?: boolean;
        instructions?: string;
        report?: CustomAgentResolveReport;
    } = {},
) => {
    render(
        <AgentKnowledgeField
            agentId="valves"
            knowledge={knowledge}
            report={over.report ?? report()}
            canEdit={over.canEdit ?? true}
            onChange={onChange}
            teamId="team-1"
            repositoryId="repo-1"
            instructions={
                over.instructions ??
                "Read the rules in irrigation-rules before commenting."
            }
        />,
    );
    return onChange;
};

const stubCommandList = () => {
    // The command list measures itself; jsdom has no ResizeObserver.
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView ??= jest.fn();
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
                              reason: `${RULES} is not connected to Kodus; select it in Git settings.`,
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
                `${RULES} is not connected to Kodus; select it in Git settings.`,
            ),
        ).toBeInTheDocument();
    });

    it("lists every connected repository under Other repository", () => {
        stubCommandList();
        field([]);

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Other repository…" }),
        );

        expect(screen.getByText("greenhouse/dashboard")).toBeInTheDocument();
        // While picking, what the previous source offers is out of the way.
        expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(
            screen.getByRole("button", { name: "Done" }),
        ).toBeInTheDocument();
    });

    it.each([
        ["follows nothing from it", [], "No skills or docs found"],
        [
            "already follows a doc of it",
            [
                {
                    path: "stack/node/rules/valves.md",
                    kind: "doc" as const,
                    repository: RULES,
                    linkedTo: [{ agentId: "valves" }],
                },
            ],
            "Nothing else found",
        ],
    ])(
        "says what an empty repository offers when the agent %s",
        (_case, knowledge: KnowledgeItem[], start) => {
            mockResolve.mockImplementation((params) =>
                params?.source?.repository && params.enabled !== false
                    ? {
                          isLoading: false,
                          isFetching: false,
                          data: report({
                              candidates: [],
                              discoveredIn: {
                                  repository: RULES,
                                  branch: "trunk",
                                  available: true,
                              },
                          }),
                      }
                    : { isLoading: false, isFetching: false, data: undefined },
            );
            field(knowledge);

            fireEvent.click(
                screen.getByRole("button", { name: "Add skill or doc" }),
            );
            fireEvent.click(
                screen.getByRole("button", { name: "irrigation-rules" }),
            );

            expect(
                screen.getByText(`${start} in ${RULES}. Add one by path.`),
            ).toBeInTheDocument();
        },
    );

    it("offers nothing to change without edit rights, and no hint for instructions naming no linked repository", () => {
        field([], jest.fn(), {
            canEdit: false,
            instructions: "Flag imports that cross a layer boundary.",
        });

        expect(screen.queryByRole("note")).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Add skill or doc" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Browse its rules" }),
        ).toBeNull();
    });

    it("shows no rows of the previous source while the picked repository loads", () => {
        mockResolve.mockImplementation((params) =>
            params?.source?.repository && params.enabled !== false
                ? { ...remoteListing, isFetching: true }
                : { isLoading: false, isFetching: false, data: undefined },
        );
        field([]);

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "irrigation-rules" }),
        );

        expect(screen.getByText(`Reading ${RULES}…`)).toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Follow stack/node/rules/valves.md",
            }),
        ).toBeNull();
    });

    it("keeps the selected repository's tab when more repositories are in use than tabs", () => {
        // Two past the cap, so the selected one falls outside any prefix.
        const inUse = [
            "greenhouse/a",
            "greenhouse/b",
            "greenhouse/c",
            "greenhouse/d",
            RULES,
        ];
        field(
            inUse.map((repository) => ({
                path: "x.md",
                kind: "doc" as const,
                repository,
                linkedTo: [{ agentId: "valves" }],
            })),
            jest.fn(),
            { report: report({ linkedRepositories: [] }) },
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        stubCommandList();
        mockResolve.mockImplementation((params) =>
            params?.listConnected && params.enabled !== false
                ? {
                      isLoading: false,
                      isFetching: false,
                      data: report({ connectedRepositories: inUse }),
                  }
                : params?.source?.repository && params.enabled !== false
                  ? remoteListing
                  : { isLoading: false, isFetching: false, data: undefined },
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Other repository…" }),
        );
        fireEvent.click(screen.getByText(RULES));

        expect(
            screen.getByRole("button", {
                name: "irrigation-rules",
                pressed: true,
            }),
        ).toBeInTheDocument();
    });

    it("says the repositories could not be listed instead of loading forever", () => {
        stubCommandList();
        mockResolve.mockImplementation((params) =>
            params?.listConnected && params.enabled !== false
                ? {
                      isLoading: false,
                      isFetching: false,
                      data: report({
                          connectedRepositories: [],
                          listingFailed: true,
                      }),
                  }
                : { isLoading: false, isFetching: false, data: undefined },
        );
        field([]);

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Other repository…" }),
        );

        expect(
            screen.getByText(
                "Could not list your repositories. Try again later.",
            ),
        ).toBeInTheDocument();
    });

    it("says a repository could not be read instead of that it has nothing", () => {
        mockResolve.mockImplementation((params) =>
            params?.source?.repository && params.enabled !== false
                ? {
                      isLoading: false,
                      isFetching: false,
                      isError: true,
                      data: undefined,
                  }
                : { isLoading: false, isFetching: false, data: undefined },
        );
        field([]);

        fireEvent.click(
            screen.getByRole("button", { name: "Add skill or doc" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "irrigation-rules" }),
        );

        expect(
            screen.getByText(`Could not read ${RULES}. Try again.`),
        ).toBeInTheDocument();
        expect(screen.queryByText(/No skills or docs found/)).toBeNull();
    });

    it("stops loading this repository's list once the page check answers, even unavailable", () => {
        mockResolve.mockReturnValue({
            isLoading: false,
            isFetching: false,
            data: undefined,
        });
        const pending = renderHook(() =>
            useKnowledgeSourceListing({ source: {}, enabled: true }),
        );
        expect(pending.result.current.loading).toBe(true);

        const answered = renderHook(() =>
            useKnowledgeSourceListing({
                source: {},
                enabled: true,
                report: {
                    ...report(),
                    knowledge: {
                        status: "unavailable",
                        reason: "Could not read the repository.",
                    },
                },
            }),
        );
        expect(answered.result.current).toMatchObject({
            loading: false,
            unavailable: "Could not read the repository.",
        });
    });
});
