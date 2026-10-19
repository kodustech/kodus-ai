/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { CustomAgent } from "@services/custom-agents/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";

import {
    CodeReviewSettingsConflictError,
    CodeReviewSettingsValidationError,
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
const drip: CustomAgent = { ...ledger, id: "drip", name: "Drip reviewer" };
const sprinkler: CustomAgent = {
    ...ledger,
    id: "sprinkler",
    name: "Sprinkler reviewer",
};

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

let mockLevel = "repository";
jest.mock("../../../_hooks", () => ({
    useCodeReviewRouteParams: () => ({
        repositoryId: "repo-1",
        directoryId: mockLevel === "directory" ? "dir-1" : undefined,
        pageName: "review-scope",
    }),
    useCurrentConfigLevel: () => mockLevel,
}));

jest.mock("../../_hooks/use-code-review-settings-mutation", () => ({
    useCodeReviewSettingsMutation: () => ({
        saveSettings: (...args: [any, any]) => saveSettings(...args),
    }),
}));

// What the settings shell loads for a scope: the formatted lists and, beside
// them, the revision of each list the server read.
const loaded = (agents: CustomAgent[], revision: string) => ({
    // As the settings shell loads a list: with where it is overridden.
    customAgents: {
        value: agents,
        level: "repository",
        overriddenValue: [{ ...ledger, id: "global-agent", name: "New agent" }],
        overriddenLevel: "global",
    },
    knowledge: { value: [], level: "repository" },
    customAgentsRevision: revision,
    knowledgeRevision: "knowledge-r1",
});

let formRef: UseFormReturn<any>;
const Form = ({
    children,
    defaults = loaded([ledger], "agents-r1"),
}: {
    children: ReactNode;
    defaults?: object;
}) => {
    const form = useForm<any>({
        mode: "all",
        defaultValues: defaults,
    });
    formRef = form;
    return <FormProvider {...form}>{children}</FormProvider>;
};

const Probe = () => {
    const {
        agents,
        linkableAgents,
        inheritedAgents,
        reviewKnowledge,
        setAgents,
        updateAgent,
        save,
        reset,
        isDirty,
    } = useCustomAgentsForm();
    return (
        <div>
            <span data-testid="dirty">{isDirty ? "unsaved" : "saved"}</span>
            <span data-testid="inherited">{inheritedAgents.length}</span>
            <button onClick={() => setAgents([...agents, sprinkler])}>add</button>
            <button
                onClick={() =>
                    setAgents(
                        agents.filter((agent) => agent.id !== sprinkler.id),
                    )
                }>
                remove added
            </button>
            <span data-testid="names">
                {agents.map((agent) => agent.name).join(",")}
            </span>
            <span data-testid="review-knowledge">
                {reviewKnowledge.map((item) => item.path).join(",")}
            </span>
            <span data-testid="linkable">
                {linkableAgents.map((agent) => agent.name).join(",")}
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
                        name: "Ledger reviewer",
                    }))
                }>
                rename back
            </button>
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

const renderProbe = (defaults?: object) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <Form defaults={defaults}>
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

describe("useCustomAgentsForm — undo by hand", () => {
    it("is not unsaved once an edit is typed back to the saved value", async () => {
        renderProbe();
        fireEvent.click(screen.getByText("edit"));
        await flush();
        expect(screen.getByTestId("dirty")).toHaveTextContent("unsaved");

        fireEvent.click(screen.getByText("rename back"));
        await flush();
        expect(screen.getByTestId("dirty")).toHaveTextContent("saved");
        // What the page compares: the edited node carried a revision and lost
        // the override fields, so the same list never matched the saved one.
        expect(formRef.getValues("customAgents")).toEqual(
            formRef.control._defaultValues.customAgents,
        );
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

    it("names the agent and the field the server refused", () => {
        // One oversized agent fails the whole save; the toast used to say
        // only "An error occurred", with no way to find the agent.
        expect(
            customAgentsSaveErrorMessage(
                new CodeReviewSettingsValidationError([
                    "configValue.customAgents.1.tools.astGrepConfig allows at most 64000 bytes",
                ]),
                "Couldn't save.",
                [ledger, audit],
            ),
        ).toBe("Audit reviewer: tools.astGrepConfig allows at most 64000 bytes");
    });

    it("names each agent when the server joined several refusals in one message", () => {
        expect(
            customAgentsSaveErrorMessage(
                new CodeReviewSettingsValidationError([
                    "configValue.customAgents.0.name should not be empty, configValue.customAgents.1.instructions must be shorter than or equal to 8000 characters",
                ]),
                "Couldn't save.",
                [ledger, audit],
            ),
        ).toBe(
            "Ledger reviewer: name should not be empty · Audit reviewer: instructions must be shorter than or equal to 8000 characters",
        );
    });

    it("falls back to the caller's message for a refusal about something else", () => {
        expect(
            customAgentsSaveErrorMessage(
                new CodeReviewSettingsValidationError([
                    "configValue.language must be a string",
                ]),
                "Couldn't save.",
                [ledger],
            ),
        ).toBe("Couldn't save.");
    });

    it("falls back to the caller's message for other errors", () => {
        expect(
            customAgentsSaveErrorMessage(new Error("boom"), "Couldn't save."),
        ).toBe("Couldn't save.");
    });
});

describe("useCustomAgentsForm — at a directory", () => {
    const savedIds = () =>
        prepared.codeReviewConfig.customAgents.map((a: CustomAgent) => a.id);

    beforeEach(() => {
        mockLevel = "directory";
        prepared = undefined;
    });
    afterEach(() => {
        mockLevel = "repository";
    });

    it("lists and saves only the directory's agents when it has none yet", async () => {
        renderProbe({
            customAgents: { value: [ledger, audit], level: "repository" },
            knowledge: { value: [], level: "repository" },
        });
        expect(screen.getByTestId("names")).toHaveTextContent(/^$/);
        expect(screen.getByTestId("inherited")).toHaveTextContent("2");

        fireEvent.click(screen.getByText("add"));
        fireEvent.click(screen.getByText("save"));
        await flush();

        expect(savedIds()).toEqual(["sprinkler"]);
    });

    it("edits and saves the directory's own agents, still naming the inherited ones", async () => {
        renderProbe({
            customAgents: {
                value: [drip],
                level: "directory",
                overriddenValue: [ledger, audit],
                overriddenLevel: "repository",
            },
            knowledge: { value: [], level: "repository" },
        });
        expect(screen.getByTestId("names")).toHaveTextContent("Drip reviewer");

        fireEvent.click(screen.getByText("add"));
        fireEvent.click(screen.getByText("save"));
        await flush();

        expect(savedIds()).toEqual(["drip", "sprinkler"]);
        expect(screen.getByTestId("inherited")).toHaveTextContent("2");
    });

    it("is not unsaved once an agent added to a directory with none is removed again", async () => {
        // The saved node is the repository's list, which the directory does
        // not own: compared as it was, the empty list never matched it.
        renderProbe({
            customAgents: { value: [ledger, audit], level: "repository" },
            knowledge: { value: [], level: "repository" },
        });
        fireEvent.click(screen.getByText("add"));
        await flush();
        expect(screen.getByTestId("dirty")).toHaveTextContent("unsaved");

        fireEvent.click(screen.getByText("remove added"));
        await flush();
        expect(screen.getByTestId("dirty")).toHaveTextContent("saved");
        expect(formRef.getValues("customAgents")).toEqual(
            formRef.control._defaultValues.customAgents,
        );
    });

    it("offers the repository's agents as link targets, a directory agent in place of the one it replaces", () => {
        const zoneLedger = { ...ledger, name: "Zone ledger reviewer" };
        renderProbe({
            customAgents: {
                value: [zoneLedger, drip],
                level: "directory",
                overriddenValue: [ledger, audit],
                overriddenLevel: "repository",
            },
            knowledge: { value: [], level: "repository" },
        });

        expect(screen.getByTestId("linkable")).toHaveTextContent(
            "Zone ledger reviewer,Audit reviewer,Drip reviewer",
        );
    });

    it("reads the repository's skills and docs too, a directory item in place of the one with its path", () => {
        const doc = (path: string, agents: string[]) =>
            ({ kind: "doc", path, agents }) as any;
        renderProbe({
            customAgents: { value: [], level: "repository" },
            knowledge: {
                value: [doc("docs/zones.md", ["ledger"]), doc("docs/drip.md", ["drip"])],
                level: "directory",
                overriddenValue: [doc("docs/style.md", ["ledger"]), doc("docs/zones.md", ["audit"])],
                overriddenLevel: "repository",
            },
        });

        expect(screen.getByTestId("review-knowledge")).toHaveTextContent(
            "docs/style.md,docs/zones.md,docs/drip.md",
        );
    });

    it("leaves the repository level as it was", async () => {
        mockLevel = "repository";
        renderProbe();
        expect(screen.getByTestId("inherited")).toHaveTextContent("0");
        expect(screen.getByTestId("linkable")).toHaveTextContent(
            "Ledger reviewer",
        );

        fireEvent.click(screen.getByText("add"));
        fireEvent.click(screen.getByText("save"));
        await flush();

        expect(savedIds()).toEqual(["ledger", "sprinkler"]);
    });
});
