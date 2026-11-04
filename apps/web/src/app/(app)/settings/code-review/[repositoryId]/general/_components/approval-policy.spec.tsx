/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { useCodeReviewSettingsMutation } from "../../../_hooks/use-code-review-settings-mutation";
import { ApprovalPolicySettings } from "./approval-policy";
import { PullRequestApprovalActive } from "./pull-request-approval-active";

const save = jest.fn();
jest.mock("src/core/utils/reactQuery", () => ({
    generateQueryKey: (path: string, options?: unknown) => [path, options],
}));
jest.mock("@services/parameters/fetch", () => ({
    createOrUpdateCodeReviewParameter: (...args: unknown[]) => save(...args),
}));
jest.mock(
    "src/app/(app)/settings/_components/use-code-management-platform",
    () => ({ useApprovalLabelsUnavailable: () => false }),
);
jest.mock("src/app/(app)/settings/code-review/_components/override", () => ({
    OverrideIndicatorForm: () => null,
}));

function Settings({
    repositoryId,
    directoryId,
}: {
    repositoryId: string;
    directoryId?: string;
}) {
    const form = useForm<any>({
        defaultValues: {
            pullRequestApprovalActive: { value: false, level: "global" },
            approvalRiskActive: { value: false, level: "global" },
            approvalLabels: { value: [], level: "global" },
            approvalAuthors: { value: [], level: "global" },
            approvalSensitivePaths: { value: [], level: "global" },
        },
    });
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId: "team",
        repositoryId,
        directoryId,
        form,
    });
    return (
        <FormProvider {...form}>
            <form
                onSubmit={form.handleSubmit((values) => saveSettings(values))}>
                <PullRequestApprovalActive conditionalApprovalEnabled />
                <ApprovalPolicySettings />
                <button type="submit">Save</button>
            </form>
        </FormProvider>
    );
}

beforeEach(() => save.mockReset().mockResolvedValue(true));

beforeAll(() => {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
});

it.each([
    { repositoryId: "global" },
    { repositoryId: "repo" },
    { repositoryId: "repo", directoryId: "directory" },
])("saves risk and automatic approval together for %j", async (scope) => {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <Settings {...scope} />
        </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Assess PR risk" }));
    expect(
        screen.getByRole("switch", { name: "Automatic PR approval" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({
        approvalRiskActive: true,
        pullRequestApprovalActive: true,
    });
});

it("undoes unsaved automatic activation and respects subsequent explicit parent choices", () => {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <Settings repositoryId="repo" />
        </QueryClientProvider>,
    );
    const risk = screen.getByRole("switch", { name: "Assess PR risk" });
    const approval = screen.getByRole("switch", {
        name: "Automatic PR approval",
    });
    fireEvent.click(risk);
    fireEvent.click(risk);
    expect(approval).not.toBeChecked();
    fireEvent.click(risk);
    fireEvent.click(approval);
    expect(approval).not.toBeChecked();
    expect(risk).toBeChecked();
    fireEvent.click(approval);
    fireEvent.click(risk);
    expect(approval).toBeChecked();
});

it("keeps saved approval enabled when risk is subsequently switched off", async () => {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <Settings repositoryId="repo" />
        </QueryClientProvider>,
    );
    const risk = screen.getByRole("switch", { name: "Assess PR risk" });
    fireEvent.click(risk);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(risk);
    expect(
        screen.getByRole("switch", { name: "Automatic PR approval" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toEqual({ approvalRiskActive: false });
});
