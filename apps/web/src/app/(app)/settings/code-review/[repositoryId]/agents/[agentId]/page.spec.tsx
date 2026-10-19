/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { CustomAgent } from "@services/custom-agents/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

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
    reviewScopeHref: (repositoryId: string) =>
        `/settings/code-review/${repositoryId}/review-scope`,
    skillsPageHref: (repositoryId: string) =>
        `/settings/code-review/${repositoryId}/skills`,
    useCustomAgentsForm: () => ({
        teamId: "team-1",
        repositoryId: "repo-1",
        directoryId: undefined,
        agents: [agent],
        knowledge: [],
        isDirty: false,
        isSubmitting: false,
        setKnowledge: jest.fn(),
        updateAgent,
        save,
        reset: jest.fn(),
    }),
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
    useResolveCustomAgent: () => ({ isLoading: false, data: undefined }),
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

jest.mock("../../../../_components/context", () => ({
    useFeatureFlags: () => ({ customAgents: true }),
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
});
