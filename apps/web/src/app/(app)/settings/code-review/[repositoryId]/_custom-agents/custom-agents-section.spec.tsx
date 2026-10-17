/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { StrictMode, type ReactNode } from "react";
import type { CustomAgent } from "@services/custom-agents/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { CustomAgentsSection } from "./custom-agents-section";

const agent: CustomAgent = {
    id: "ledger",
    name: "Ledger reviewer",
    enabled: true,
    instructions: "Every posting balances.",
    scope: {},
    tools: {},
    presentation: {
        tag: { color: "#304FFE" },
        format: "inline",
        suggestedFix: "when-confident",
    },
};

const report = {
    knowledge: { status: "ok", items: [], candidates: [], budgets: [] },
    mcp: { status: "ok", integrations: [] },
};

let releaseResolve: Array<() => void> = [];

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href, ...rest }: any) => (
        <a href={typeof href === "string" ? href : ""} {...rest}>
            {children}
        </a>
    ),
}));

jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("@services/custom-agents/fetch", () => ({
    CUSTOM_AGENTS_PATHS: { STATUS: "status", RESOLVE: "resolve" },
    getCustomAgentsStatus: async () => ({ windowDays: 30, agents: [] }),
    resolveCustomAgent: () =>
        new Promise((resolve) => releaseResolve.push(() => resolve(report))),
    tryCustomAgent: jest.fn(),
}));

jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team-1" }),
}));

jest.mock("../../../_hooks", () => ({
    useCodeReviewRouteParams: () => ({
        repositoryId: "repo-1",
        directoryId: undefined,
        pageName: "review-scope",
    }),
    useCurrentConfigLevel: () => "repository",
}));

jest.mock("../../_hooks/use-code-review-settings-mutation", () => ({
    useCodeReviewSettingsMutation: () => ({ saveSettings: jest.fn() }),
}));

jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: async () => null,
}));

const Form = ({ children }: { children: ReactNode }) => {
    const form = useForm<any>({
        defaultValues: {
            customAgents: { value: [agent], level: "repository" },
            knowledge: { value: [], level: "repository" },
        },
    });
    return <FormProvider {...form}>{children}</FormProvider>;
};

const renderSection = () => {
    const client = new QueryClient();
    return render(
        <StrictMode>
            <QueryClientProvider client={client}>
                <Form>
                    <CustomAgentsSection canEdit />
                </Form>
            </QueryClientProvider>
        </StrictMode>,
    );
};

const flush = () => act(async () => {});

describe("CustomAgentsSection", () => {
    beforeEach(() => {
        releaseResolve = [];
    });

    it("opens an agent row on the first click of Configure", async () => {
        renderSection();
        await flush();

        fireEvent.click(screen.getByRole("button", { name: /configure/i }));
        await flush();

        expect(screen.getByLabelText("Instructions")).toBeInTheDocument();
    });

    it("keeps the row open while the skill discovery resolves", async () => {
        renderSection();

        fireEvent.click(screen.getByRole("button", { name: /configure/i }));
        await act(async () => {
            releaseResolve.forEach((release) => release());
        });
        await flush();

        expect(screen.getByLabelText("Instructions")).toBeInTheDocument();
    });
});
