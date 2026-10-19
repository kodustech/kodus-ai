/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { toast } from "@components/ui/toaster/use-toast";
import type { CustomAgent, KnowledgeItem } from "@services/custom-agents/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import {
    CodeReviewSettingsConflictError,
    STALE_CUSTOM_AGENTS_MESSAGE,
} from "../../../_utils/settings-save-conflict";
import CustomAgentPage from "./page";

const agent: CustomAgent = {
    id: "ledger",
    name: "Ledger reviewer",
    enabled: true,
    instructions: "Every posting must balance.",
    scope: { include: ["src/payments/**"] },
    tools: {},
    presentation: {
        tag: { color: "#6366f1" },
        format: "inline",
        suggestedFix: "when-confident",
    },
};

const push = jest.fn();
const save = jest.fn();
const updateAgent = jest.fn();
const setAgents = jest.fn();
const setKnowledge = jest.fn();

// What the form gives the page; a test at a directory overrides the lists.
const formAt = (overrides = {}) => ({
    teamId: "team-1",
    repositoryId: "repo-1",
    directoryId: undefined as string | undefined,
    agents: [agent],
    linkableAgents: [agent],
    knowledge: [] as KnowledgeItem[],
    reviewKnowledge: [] as KnowledgeItem[],
    inheritedAgents: [] as CustomAgent[],
    isDirty: false,
    isSubmitting: false,
    setAgents,
    setKnowledge,
    updateAgent,
    save,
    reset: jest.fn(),
    ...overrides,
});
let mockForm = formAt();
let mockResolve: unknown;

jest.mock("next/navigation", () => ({
    useParams: () => ({ agentId: "ledger" }),
    useRouter: () => ({ push, refresh: jest.fn() }),
}));

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href, ...rest }: any) => (
        <a href={typeof href === "string" ? href : ""} {...rest}>
            {children}
        </a>
    ),
}));

jest.mock("../../_custom-agents/use-custom-agents-form", () => ({
    agentPageHref: (repositoryId: string, agentId: string) =>
        `/settings/code-review/${repositoryId}/agents/${agentId}`,
    reviewScopeHref: (repositoryId: string) =>
        `/settings/code-review/${repositoryId}/review-scope`,
    skillsPageHref: (repositoryId: string) =>
        `/settings/code-review/${repositoryId}/skills`,
    useCustomAgentsForm: () => mockForm,
}));

jest.mock("@services/custom-agents/hooks", () => ({
    useCustomAgentsStatus: () => ({
        isLoading: false,
        data: {
            windowDays: 30,
            agents: [
                { agentId: "ledger", pullRequests: 9, posted: 15, dropped: 2 },
            ],
        },
    }),
    useResolveCustomAgent: () => ({ isLoading: false, data: mockResolve }),
    useSettled: (value: unknown) => value,
    useTryCustomAgent: () => ({
        mutate: jest.fn(),
        reset: jest.fn(),
        isPending: false,
    }),
}));

jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));

const TRIAL = {
    valid: true,
    subscriptionStatus: "trial",
    planType: "teams_managed",
};
let mockLicense: Record<string, unknown> = TRIAL;
jest.mock(
    "src/features/ee/subscription/_providers/subscription-context",
    () => ({
        useSubscriptionContext: () => ({ license: mockLicense }),
    }),
);

const captureGateHit = jest.fn();
jest.mock("src/core/utils/gate-hit", () => ({
    captureGateHit: (...args: unknown[]) => captureGateHit(...args),
    captureGateCtaClick: jest.fn(),
}));

jest.mock("src/core/hooks/use-unsaved-changes-guard", () => ({
    useUnsavedChangesGuard: jest.fn(),
}));

jest.mock("../../../_components/centralized-config-readonly-alert", () => ({
    CentralizedConfigReadOnlyAlert: () => null,
}));

jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: async () => null,
}));

jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const renderPage = async () => {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <CustomAgentPage />
        </QueryClientProvider>,
    );
    await act(async () => {});
};

describe("Custom agent page", () => {
    beforeEach(() => {
        push.mockReset();
        save.mockReset();
        save.mockResolvedValue({});
        updateAgent.mockReset();
        setAgents.mockReset();
        setKnowledge.mockReset();
        mockForm = formAt();
    });

    it("on free, is locked with the upgrade card and shows nothing of the agent", async () => {
        mockLicense = {
            valid: true,
            subscriptionStatus: "active",
            planType: "free_byok",
        };
        try {
            await renderPage();
            expect(
                screen.getByRole("heading", { name: "Unlock custom agents" }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole("link", { name: "See plans" }),
            ).toHaveAttribute("href", "/choose-plan");
            expect(captureGateHit).toHaveBeenCalledWith(
                expect.objectContaining({
                    feature: "custom_agents",
                    surface: "locked_preview",
                    planType: "free_byok",
                }),
            );
            expect(screen.queryByText("Ledger reviewer")).toBeNull();
            expect(screen.queryByLabelText("Instructions")).toBeNull();
            expect(screen.queryByText("Run agent")).toBeNull();
        } finally {
            mockLicense = TRIAL;
        }
    });

    it("on a trial, opens the agent", async () => {
        await renderPage();
        expect(screen.queryByText("Unlock custom agents")).toBeNull();
        expect(screen.getByLabelText("Instructions")).toBeInTheDocument();
    });

    it("leads back to What to review, where the agents are listed", async () => {
        await renderPage();
        expect(
            screen.getByRole("link", { name: "What to review" }),
        ).toHaveAttribute("href", "/settings/code-review/repo-1/review-scope");
        expect(screen.queryByText("Beta")).toBeNull();
    });

    it("shows one status line, with the switch, where it runs and usage", async () => {
        await renderPage();
        const strips = screen.getAllByTestId("agent-status");
        expect(strips).toHaveLength(1);
        expect(strips[0]).toHaveTextContent(
            "Runs on src/payments/** · 9 PRs · 15 posted in 30 days",
        );
        expect(
            screen.queryByText(/^On a pull request that changes/),
        ).toBeNull();

        fireEvent.click(
            within(strips[0]).getByRole("switch", { name: "Agent enabled" }),
        );
        expect(updateAgent).toHaveBeenCalledWith(
            "ledger",
            expect.any(Function),
        );
        const patch = updateAgent.mock.calls[0][1];
        expect(patch(agent).enabled).toBe(false);
    });

    it("has the four config cards and Try it in its own panel", async () => {
        await renderPage();
        for (const title of [
            "Instructions",
            "Files & knowledge",
            "Tools",
            "Comments & model",
        ]) {
            expect(screen.getAllByText(title).length).toBeGreaterThan(0);
        }
        const panel = screen.getByTestId("try-it-panel");
        expect(
            within(panel).getByRole("region", { name: "Try it" }),
        ).toBeInTheDocument();
    });

    it("deletes only after the confirm dialog, then goes back to What to review", async () => {
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));
        const dialog = await screen.findByRole("dialog");
        expect(save).not.toHaveBeenCalled();

        fireEvent.click(
            within(dialog).getByRole("button", { name: "Delete agent" }),
        );
        await act(async () => {});

        expect(save).toHaveBeenCalledWith({ agents: [], knowledge: [] });
        expect(push).toHaveBeenCalledWith(
            "/settings/code-review/repo-1/review-scope",
        );
    });

    describe("at a directory", () => {
        const zoneDoc: KnowledgeItem = {
            path: "docs/zone.md",
            kind: "doc",
            linkedTo: [{ agentId: "ledger" }],
        };

        it("opens a repository agent read-only, with its links editable here", async () => {
            mockForm = formAt({
                directoryId: "dir-1",
                agents: [],
                knowledge: [zoneDoc],
                inheritedAgents: [agent],
            });
            await renderPage();

            const note = screen.getByRole("note");
            expect(note).toHaveTextContent(
                "This agent comes from the repository",
            );
            expect(
                within(note).getByRole("link", {
                    name: "Edit it on the repository",
                }),
            ).toHaveAttribute(
                "href",
                "/settings/code-review/repo-1/agents/ledger",
            );
            expect(screen.getByLabelText("Instructions")).toBeDisabled();
            expect(screen.getByLabelText("Instructions")).toHaveValue(
                "Every posting must balance.",
            );
            expect(
                screen.getByRole("switch", { name: "Agent enabled" }),
            ).toBeDisabled();
            expect(
                screen.queryByRole("button", { name: "Delete agent" }),
            ).toBeNull();
            expect(
                within(screen.getByTestId("try-it-panel")).getByRole("region", {
                    name: "Try it",
                }),
            ).toBeInTheDocument();

            fireEvent.click(
                screen.getByRole("button", {
                    name: "Stop following docs/zone.md",
                }),
            );
            // The doc's one link was this agent's: unfollowed, it goes.
            expect(setKnowledge).toHaveBeenCalledWith([]);
        });

        it("refuses a name a repository agent it runs next to answers to", async () => {
            const drip = { ...agent, id: "drip", name: "Drip reviewer" };
            const ledger = { ...agent, name: "Drip Reviewer" };
            mockForm = formAt({
                directoryId: "dir-1",
                agents: [ledger],
                linkableAgents: [drip, ledger],
                inheritedAgents: [drip],
            });
            await renderPage();

            expect(
                screen.getByText(/already answers to @kody -v drip-reviewer/),
            ).toBeInTheDocument();
        });

        it("overrides a repository agent with a copy in the directory's list", async () => {
            const drip = { ...agent, id: "drip", name: "Drip reviewer" };
            mockForm = formAt({
                directoryId: "dir-1",
                agents: [drip],
                inheritedAgents: [agent],
            });
            await renderPage();

            fireEvent.click(
                screen.getByRole("button", {
                    name: "Override at this directory",
                }),
            );
            expect(setAgents).toHaveBeenCalledWith([drip, agent]);
        });

        it("keeps the directory's links when deleting an override, saying the repository's agent takes over", async () => {
            const zoneLedger = { ...agent, name: "Zone ledger reviewer" };
            mockForm = formAt({
                directoryId: "dir-1",
                agents: [zoneLedger],
                knowledge: [zoneDoc],
                inheritedAgents: [agent],
            });
            await renderPage();
            expect(screen.queryByRole("note")).toBeNull();
            expect(screen.getByLabelText("Instructions")).toBeEnabled();

            fireEvent.click(
                screen.getByRole("button", { name: "Delete agent" }),
            );
            const dialog = await screen.findByRole("dialog");
            expect(dialog).toHaveTextContent(
                "The repository's Ledger reviewer runs here again",
            );
            fireEvent.click(
                within(dialog).getByRole("button", { name: "Delete agent" }),
            );
            await act(async () => {});

            expect(save).toHaveBeenCalledWith({
                agents: [],
                knowledge: [zoneDoc],
            });
        });
    });
});

describe("Custom agent page over its docs budget", () => {
    beforeEach(() => {
        mockForm = formAt({ isDirty: true });
        mockResolve = {
            repository: { id: "repo-1", name: "repo", branch: "main" },
            agentIssues: [],
            astGrep: { ruleCount: 0, ruleIds: [], errors: [] },
            knowledge: {
                status: "ok",
                items: [],
                candidates: [],
                budgets: [
                    {
                        target: "agent:ledger",
                        skills: 0,
                        docs: 1,
                        docTokens: 23900,
                        over: ["docTokens"],
                    },
                ],
            },
            mcp: { status: "ok", integrations: [] },
        };
        save.mockReset();
        save.mockResolvedValue({});
        (toast as jest.Mock).mockClear();
    });
    afterEach(() => {
        mockForm = formAt();
        mockResolve = undefined;
    });

    it("says so on the agent and when it is saved", async () => {
        await renderPage();
        expect(
            screen.getByText(/Over the limit for this agent \(doc tokens\)/),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /save/i }));
        await act(async () => {});

        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "warning",
                description: expect.stringMatching(
                    /^Agent saved\. Ledger reviewer is over its limit \(doc tokens\)/,
                ),
            }),
        );
    });

    it("keeps the stale-save toast up until dismissed, without logging an error", async () => {
        // A refused stale save logged with console.error, which the dev
        // overlay showed as an issue, and its toast closed in 5 seconds.
        save.mockRejectedValue(new CodeReviewSettingsConflictError());
        const error = jest.spyOn(console, "error").mockImplementation(() => {});
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: /save/i }));
        await act(async () => {});

        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "danger",
                description: STALE_CUSTOM_AGENTS_MESSAGE,
                duration: Infinity,
            }),
        );
        expect(error).not.toHaveBeenCalled();
        error.mockRestore();
    });
});
