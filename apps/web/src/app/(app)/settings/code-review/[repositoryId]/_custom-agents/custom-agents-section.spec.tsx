/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { StrictMode, type ReactNode } from "react";
import { newCliTool } from "@services/custom-agents/drafts";
import type { CustomAgent } from "@services/custom-agents/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { shouldBlockCodeReviewLayoutNavigation } from "../_utils/layout-dirty-state";
import {
    CustomAgentsList,
    CustomAgentsSection,
} from "./custom-agents-section";
import { ownListNote, useCustomAgentsForm } from "./use-custom-agents-form";

const agent: CustomAgent = {
    id: "ledger",
    name: "Ledger reviewer",
    enabled: true,
    instructions: "# Ledger rules\nEvery posting balances.",
    scope: { include: ["src/payments/**"] },
    tools: {
        cli: [{ ...newCliTool(), name: "semver", binary: "semver" }],
    },
    presentation: {
        tag: { color: "#304FFE" },
        format: "inline",
        suggestedFix: "when-confident",
    },
};

const knowledge = [
    {
        path: "docs/ledger.md",
        kind: "doc" as const,
        linkedTo: [{ agentId: "ledger" }],
    },
];

const push = jest.fn();
const saveSettings = jest.fn();

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href, ...rest }: any) => (
        <a href={typeof href === "string" ? href : ""} {...rest}>
            {children}
        </a>
    ),
}));

jest.mock("next/navigation", () => ({
    useRouter: () => ({ push, refresh: jest.fn() }),
}));

jest.mock("@services/custom-agents/fetch", () => ({
    CUSTOM_AGENTS_PATHS: { STATUS: "status", RESOLVE: "resolve" },
    getCustomAgentsStatus: async () => ({
        windowDays: 30,
        agents: [
            { agentId: "ledger", pullRequests: 9, posted: 15, dropped: 2 },
        ],
    }),
    resolveCustomAgent: async () => ({
        knowledge: { status: "ok", items: [], candidates: [], budgets: [] },
        mcp: { status: "ok", integrations: [] },
    }),
    tryCustomAgent: jest.fn(),
}));

jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team-1" }),
}));

jest.mock("../../../_hooks", () => ({
    useCodeReviewRouteParams: () => ({
        repositoryId: "repo-1",
        directoryId: undefined,
        pageName: "agents",
    }),
    useCurrentConfigLevel: () => "repository",
}));

jest.mock("../../_hooks/use-code-review-settings-mutation", () => ({
    useCodeReviewSettingsMutation: () => ({ saveSettings }),
}));

jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: async () => null,
}));

type Node = Record<string, unknown>;

// Like the settings layout: it owns the form and computes its leave guard from
// the root `formState`, so it only sees what re-renders the form's root.
const Form = ({
    children,
    agentsNode,
}: {
    children: ReactNode;
    agentsNode?: Node;
}) => {
    const form = useForm<any>({
        mode: "all",
        defaultValues: {
            customAgents: agentsNode ?? {
                value: [agent],
                level: "repository",
            },
            knowledge: { value: knowledge, level: "repository" },
        },
    });
    const { dirtyFields } = form.formState;
    return (
        <FormProvider {...form}>
            {children}
            <span data-testid="layout-blocks">
                {String(
                    shouldBlockCodeReviewLayoutNavigation({
                        dirtyFields: dirtyFields as Record<string, unknown>,
                        formIsSubmitting: false,
                    }),
                )}
            </span>
        </FormProvider>
    );
};

const renderList = (agentsNode?: Node) =>
    render(
        <StrictMode>
            <QueryClientProvider client={new QueryClient()}>
                <Form agentsNode={agentsNode}>
                    <CustomAgentsList canEdit />
                </Form>
            </QueryClientProvider>
        </StrictMode>,
    );

const flush = () => act(async () => {});

/** The agents a save sent, as the server receives them. */
const savedAgents = (call = 0): CustomAgent[] => {
    const [formData, options] = saveSettings.mock.calls[call];
    return options.prepare(formData).codeReviewConfig.customAgents;
};

const openMenu = () => {
    fireEvent.keyDown(
        screen.getByRole("button", {
            name: "More actions for Ledger reviewer",
        }),
        { key: "Enter" },
    );
};

describe("CustomAgentsList", () => {
    beforeEach(() => {
        push.mockReset();
        saveSettings.mockReset();
        saveSettings.mockResolvedValue({});
    });

    it("shows one compact row: name, a short line, chips and usage", async () => {
        renderList();
        await flush();

        const [row] = within(
            screen.getByRole("list", { name: "Custom agents" }),
        ).getAllByRole("listitem");
        expect(
            within(row).getByRole("link", { name: "Ledger reviewer" }),
        ).toBeInTheDocument();
        expect(within(row).getByText("Ledger rules")).toBeInTheDocument();
        expect(within(row).queryByText(/Every posting/)).toBeNull();
        const chips = within(row).getByRole("list", { name: "Setup" });
        expect(
            within(chips)
                .getAllByRole("listitem")
                .map((item) => item.textContent),
        ).toEqual(["src/payments/**", "1 doc", "semver CLI"]);
        expect(
            await within(row).findByText("9 PRs · 15 posted · 30 days"),
        ).toBeInTheDocument();
        // The switch leads the row, as the categories' switches do.
        const [first] = within(row).getAllByRole("switch");
        expect(
            first.compareDocumentPosition(
                within(row).getByRole("link", { name: "Ledger reviewer" }),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        // No inline editing: the agent page is the one place to configure.
        expect(screen.queryByRole("button", { name: /configure/i })).toBeNull();
        expect(screen.queryByLabelText("Instructions")).toBeNull();
    });

    it("opens the agent page from the row", async () => {
        renderList();
        await flush();
        expect(
            screen.getByRole("link", { name: "Ledger reviewer" }),
        ).toHaveAttribute("href", "/settings/code-review/repo-1/agents/ledger");
    });

    it("saves the list when an agent is switched off", async () => {
        renderList();
        await flush();

        fireEvent.click(
            screen.getByRole("switch", { name: "Ledger reviewer enabled" }),
        );
        await flush();

        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(savedAgents()[0]).toMatchObject({
            id: "ledger",
            enabled: false,
        });
    });

    it("edits from the ⋯ menu", async () => {
        renderList();
        await flush();

        openMenu();
        fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
        expect(push).toHaveBeenLastCalledWith(
            "/settings/code-review/repo-1/agents/ledger",
        );
    });

    it("tries from the ⋯ menu", async () => {
        renderList();
        await flush();

        openMenu();
        fireEvent.click(
            await screen.findByRole("menuitem", { name: "Try it" }),
        );
        expect(push).toHaveBeenLastCalledWith(
            "/settings/code-review/repo-1/agents/ledger#try-it",
        );
    });

    it("deletes from the ⋯ menu only after the confirm dialog", async () => {
        renderList();
        await flush();

        openMenu();
        fireEvent.click(
            await screen.findByRole("menuitem", { name: "Delete" }),
        );
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveTextContent("Delete Ledger reviewer?");
        expect(saveSettings).not.toHaveBeenCalled();

        fireEvent.click(
            within(dialog).getByRole("button", { name: "Delete agent" }),
        );
        await flush();

        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(savedAgents()).toEqual([]);
    });

    it("says when this repository's own list hides the global agents", async () => {
        renderList({
            value: [agent],
            level: "repository",
            overriddenLevel: "global",
            overriddenValue: [],
        });
        await flush();
        expect(screen.getByRole("note")).toHaveTextContent(
            "This repository has its own agents list. Changes to the global agents don't reach it.",
        );
    });

    it("says nothing when the list is inherited", async () => {
        renderList({ value: [agent], level: "global" });
        await flush();
        expect(screen.queryByRole("note")).toBeNull();
    });

    it("explains an empty list and offers a new agent", async () => {
        renderList({ value: [], level: "repository" });
        await flush();
        expect(screen.getByText("No custom agents yet")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "New agent" }),
        ).toBeInTheDocument();
    });
});

describe("CustomAgentsSection", () => {
    it("lists the agents on the What to review page, with a way to add one", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <Form>
                    <CustomAgentsSection canEdit />
                </Form>
            </QueryClientProvider>,
        );
        await flush();

        expect(
            screen.getByRole("heading", { name: "Custom agents" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Ledger reviewer" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "New agent" }),
        ).toBeInTheDocument();
    });
});

describe("ownListNote", () => {
    it("says a repository's own list replaces the global one, and nothing else", () => {
        expect(
            ownListNote(
                { level: "repository", overriddenLevel: "global" },
                "repository",
            ),
        ).toBe(
            "This repository has its own agents list. Changes to the global agents don't reach it.",
        );
        // A directory adds its agents to the repository's.
        expect(
            ownListNote(
                { level: "directory", overriddenLevel: "repository" },
                "directory",
            ),
        ).toBeNull();
        expect(
            ownListNote(
                { level: "repository", overriddenLevel: "default" },
                "repository",
            ),
        ).toBeNull();
        expect(
            ownListNote(
                { level: "global", overriddenLevel: "default" },
                "global",
            ),
        ).toBeNull();
    });
});

const FormProbe = () => {
    const { agents, isDirty, updateAgent, reset } = useCustomAgentsForm();
    return (
        <div>
            <span data-testid="name">{agents[0]?.name}</span>
            <span data-testid="dirty">{String(isDirty)}</span>
            <button
                onClick={() =>
                    updateAgent("ledger", (current) => ({
                        ...current,
                        name: "Edited",
                    }))
                }>
                edit
            </button>
            <button onClick={reset}>reset</button>
        </div>
    );
};

describe("useCustomAgentsForm", () => {
    it("reset brings back the saved agents and clears the unsaved state", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <Form>
                    <FormProbe />
                </Form>
            </QueryClientProvider>,
        );

        fireEvent.click(screen.getByText("edit"));
        await flush();
        expect(screen.getByTestId("name")).toHaveTextContent("Edited");
        expect(screen.getByTestId("dirty")).toHaveTextContent("true");
        expect(screen.getByTestId("layout-blocks")).toHaveTextContent("true");

        fireEvent.click(screen.getByText("reset"));
        await flush();
        expect(screen.getByTestId("name")).toHaveTextContent("Ledger reviewer");
        expect(screen.getByTestId("dirty")).toHaveTextContent("false");
        // The settings layout guard reads the same form: it must let the
        // user leave once the edit is undone.
        expect(screen.getByTestId("layout-blocks")).toHaveTextContent("false");
    });
});
