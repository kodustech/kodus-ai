/** @jest-environment jsdom */
import {
    QueryClient,
    QueryClientProvider,
    QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";

import { CodeReviewSettingsConflictError } from "../_utils/settings-save-conflict";
import { useCodeReviewSettingsMutation } from "./use-code-review-settings-mutation";

const createOrUpdateCodeReviewParameter = jest.fn();

jest.mock("@services/parameters/fetch", () => ({
    createOrUpdateCodeReviewParameter: (...args: unknown[]) =>
        createOrUpdateCodeReviewParameter(...args),
}));

jest.mock("@services/parameters", () => ({
    PARAMETERS_PATHS: {
        GET_CODE_REVIEW_PARAMETER: "code-review-parameter",
        CODE_REVIEW_SCOPES: "code-review-scopes",
        GET_BY_KEY: "by-key",
    },
}));

jest.mock("src/core/utils/reactQuery", () => ({
    generateQueryKey: (path: string, options?: unknown) => [path, options],
}));

const loaded = {
    customAgents: {
        value: [{ id: "ledger", name: "Ledger reviewer" }],
        level: "repository",
    },
    automatedReviewActive: { value: true, level: "repository" },
    customAgentsRevision: "agents-r1",
    knowledgeRevision: "knowledge-r1",
};

const setup = (client = new QueryClient()) => {
    const { result } = renderHook(
        () => {
            const form = useForm<any>({ defaultValues: loaded });
            const mutation = useCodeReviewSettingsMutation({
                teamId: "team-1",
                repositoryId: "repo-1",
                form,
            });
            return { form, ...mutation };
        },
        {
            wrapper: ({ children }) => (
                <QueryClientProvider client={client}>
                    {children}
                </QueryClientProvider>
            ),
        },
    );
    return result;
};

// An edited list carries the revision its draft started from.
const draft = {
    ...loaded,
    customAgents: {
        value: [{ id: "ledger", name: "Edited here" }],
        level: "repository",
        revision: "agents-r1",
    },
};

const sentOptions = () => createOrUpdateCodeReviewParameter.mock.calls[0][5];

describe("useCodeReviewSettingsMutation — stale custom agents", () => {
    beforeEach(() => createOrUpdateCodeReviewParameter.mockReset());

    it("sends the revision of each list the save writes", async () => {
        createOrUpdateCodeReviewParameter.mockResolvedValue(true);
        const result = setup();

        await act(async () => {
            await result.current.saveSettings(draft as any);
        });

        expect(createOrUpdateCodeReviewParameter.mock.calls[0][0]).toEqual({
            customAgents: draft.customAgents.value,
        });
        expect(sentOptions()).toEqual({
            expectedRevisions: { customAgents: "agents-r1" },
        });
    });

    it("sends no revision when the save writes no list", async () => {
        createOrUpdateCodeReviewParameter.mockResolvedValue(true);
        const result = setup();

        await act(async () => {
            await result.current.saveSettings({
                ...loaded,
                automatedReviewActive: { value: false, level: "repository" },
            } as any);
        });

        expect(createOrUpdateCodeReviewParameter.mock.calls[0][0]).toEqual({
            automatedReviewActive: false,
        });
        // Called exactly as before the revision check: no extra arguments.
        expect(createOrUpdateCodeReviewParameter.mock.calls[0]).toHaveLength(4);
    });

    it("throws a conflict on 409 and keeps the edits unsaved", async () => {
        createOrUpdateCodeReviewParameter.mockResolvedValue({ error: 409 });
        const result = setup();

        let thrown: unknown;
        await act(async () => {
            try {
                await result.current.saveSettings(draft as any);
            } catch (error) {
                thrown = error;
            }
        });

        expect(thrown).toBeInstanceOf(CodeReviewSettingsConflictError);
        // Not reset to the draft: the edits still count as unsaved.
        expect(result.current.form.control._defaultValues.customAgents).toEqual(
            loaded.customAgents,
        );
    });

    it("keeps the generic error for any other failure", async () => {
        createOrUpdateCodeReviewParameter.mockResolvedValue({ error: 500 });
        const result = setup();

        await expect(
            result.current.saveSettings(draft as any),
        ).rejects.not.toBeInstanceOf(CodeReviewSettingsConflictError);
    });

    it("drops the draft revision from the saved values", async () => {
        createOrUpdateCodeReviewParameter.mockResolvedValue(true);
        const result = setup();

        await act(async () => {
            await result.current.saveSettings(draft as any);
        });

        const saved = result.current.form.control._defaultValues.customAgents;
        expect(saved.value).toEqual(draft.customAgents.value);
        expect(saved).not.toHaveProperty("revision");
    });

    it("resolves a save of the lists only once the config is read again", async () => {
        createOrUpdateCodeReviewParameter.mockResolvedValue(true);
        const client = new QueryClient();
        let releaseRefetch: () => void = () => undefined;
        // The settings shell's query, active while the page is open.
        let fetches = 0;
        const observer = new QueryObserver(client, {
            queryKey: [
                "code-review-parameter",
                { params: { teamId: "team-1" } },
            ],
            queryFn: () =>
                ++fetches === 1
                    ? Promise.resolve({})
                    : new Promise((resolve) => {
                          releaseRefetch = () => resolve({});
                      }),
        });
        const unsubscribe = observer.subscribe(() => undefined);
        await act(async () => {});
        const result = setup(client);

        let settled = false;
        let pending: Promise<unknown> = Promise.resolve();
        await act(async () => {
            pending = result.current
                .saveSettings(draft as any)
                .then(() => (settled = true));
        });
        expect(settled).toBe(false);

        await act(async () => {
            releaseRefetch();
            await pending;
        });
        expect(settled).toBe(true);
        unsubscribe();
    });
});
