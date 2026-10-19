/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { CustomAgent } from "@services/custom-agents/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";

import {
    CodeReviewSettingsConflictError,
    customAgentsSaveErrorMessage,
    expectedCustomAgentsRevisions,
} from "../../_utils/settings-save-conflict";
import { useCustomAgentsForm } from "./use-custom-agents-form";

const ledger: CustomAgent = {
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
const audit: CustomAgent = { ...ledger, id: "audit", name: "Audit reviewer" };

let prepared: any;
// What the save will send as revisions: the mutation reads them from the
// form values it is handed, for the lists the save writes.
let sentRevisions: any;
const saveSettings = jest.fn(async (formData: any, options: any) => {
    prepared = await options.prepare(formData);
    sentRevisions = expectedCustomAgentsRevisions(
        formData,
        prepared.codeReviewConfig,
    );
    return {};
});

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
    useCodeReviewSettingsMutation: () => ({
        saveSettings: (...args: [any, any]) => saveSettings(...args),
    }),
}));

// What the settings shell loads for a scope: the formatted lists and, beside
// them, the revision of each list the server read.
const loaded = (agents: CustomAgent[], revision: string) => ({
    customAgents: { value: agents, level: "repository" },
    knowledge: { value: [], level: "repository" },
    customAgentsRevision: revision,
    knowledgeRevision: "knowledge-r1",
});

let formRef: UseFormReturn<any>;
const Form = ({ children }: { children: ReactNode }) => {
    const form = useForm<any>({
        mode: "all",
        defaultValues: loaded([ledger], "agents-r1"),
    });
    formRef = form;
    return <FormProvider {...form}>{children}</FormProvider>;
};

const Probe = () => {
    const { agents, updateAgent, save, reset } = useCustomAgentsForm();
    return (
        <div>
            <span data-testid="names">
                {agents.map((agent) => agent.name).join(",")}
            </span>
            <button
                onClick={() =>
                    updateAgent("ledger", (agent) => ({
                        ...agent,
                        name: "Edited here",
                    }))
                }>
                edit
            </button>
            <button onClick={() => void save()}>save</button>
            <button
                onClick={() =>
                    updateAgent("ledger", (agent) => ({
                        ...agent,
                        name: "Temporary",
                    }))
                }>
                edit again
            </button>
            <button onClick={reset}>reset</button>
        </div>
    );
};

const renderProbe = () =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <Form>
                <Probe />
            </Form>
        </QueryClientProvider>,
    );

// What the settings layout does when the config is refetched while the user
// has unsaved edits (it keeps them and takes the server value elsewhere).
const refetch = (agents: CustomAgent[], revision: string) =>
    act(async () => {
        formRef.reset(loaded(agents, revision), {
            keepDirtyValues: true,
            keepDirty: true,
            keepErrors: true,
            keepTouched: true,
        });
    });

const flush = () => act(async () => {});

describe("useCustomAgentsForm — concurrent edits", () => {
    beforeEach(() => {
        prepared = undefined;
        sentRevisions = undefined;
        saveSettings.mockClear();
    });

    it("saves with the revision of the lists the screen loaded", async () => {
        renderProbe();
        fireEvent.click(screen.getByText("edit"));
        fireEvent.click(screen.getByText("save"));
        await flush();

        expect(sentRevisions).toEqual({
            customAgents: "agents-r1",
            knowledge: "knowledge-r1",
        });
    });

    it("keeps the revision the draft started from when the config is refetched", async () => {
        renderProbe();
        fireEvent.click(screen.getByText("edit"));
        await flush();

        // Another tab added an agent; the refetch keeps this tab's draft.
        await refetch([ledger, audit], "agents-r2");
        expect(screen.getByTestId("names")).toHaveTextContent("Edited here");

        fireEvent.click(screen.getByText("save"));
        await flush();

        // Sending r2 would let this stale draft drop the audit agent.
        expect(sentRevisions.customAgents).toBe("agents-r1");
    });

    it("takes the new revision with the new lists when nothing was edited", async () => {
        renderProbe();
        await refetch([ledger, audit], "agents-r2");

        fireEvent.click(screen.getByText("save"));
        await flush();

        expect(sentRevisions.customAgents).toBe("agents-r2");
        expect(
            prepared.codeReviewConfig.customAgents.map((a: any) => a.id),
        ).toEqual(["ledger", "audit"]);
    });
});

describe("useCustomAgentsForm — reset", () => {
    it("goes back to the last saved agents, not the ones the page loaded", async () => {
        renderProbe();
        fireEvent.click(screen.getByText("edit"));
        await flush();
        // What the settings layout does after a save: the saved config
        // becomes the form's defaults.
        await act(async () => {
            formRef.reset(
                loaded([{ ...ledger, name: "Edited here" }], "agents-r2"),
            );
        });

        fireEvent.click(screen.getByText("edit again"));
        await flush();
        expect(screen.getByTestId("names")).toHaveTextContent("Temporary");

        fireEvent.click(screen.getByText("reset"));
        await flush();
        expect(screen.getByTestId("names")).toHaveTextContent("Edited here");
        expect(formRef.formState.isDirty).toBe(false);
    });
});

describe("customAgentsSaveErrorMessage", () => {
    it("asks to reload when someone else changed the agents", () => {
        expect(
            customAgentsSaveErrorMessage(
                new CodeReviewSettingsConflictError(),
                "Couldn't save.",
            ),
        ).toMatch(/someone else changed these agents.*reload/i);
    });

    it("falls back to the caller's message for other errors", () => {
        expect(
            customAgentsSaveErrorMessage(new Error("boom"), "Couldn't save."),
        ).toBe("Couldn't save.");
    });
});
