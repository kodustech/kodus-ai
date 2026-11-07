/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ApprovalPolicy } from "@services/approval-policies/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
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
    () => ({
        useApprovalLabelsUnavailable: () => false,
        useApprovalTeamsUnavailable: () => false,
    }),
);
jest.mock("src/app/(app)/settings/code-review/_components/override", () => ({
    OverrideIndicatorForm: () => null,
}));

const docs: ApprovalPolicy = {
    id: "docs",
    name: "Docs",
    enabled: true,
    labels: ["ready"],
};
function Settings({
    repositoryId = "repo",
    directoryId,
    policies = [docs],
    disabled = false,
}: {
    repositoryId?: string;
    directoryId?: string;
    policies?: ApprovalPolicy[];
    disabled?: boolean;
}) {
    const form = useForm<any>({
        disabled,
        defaultValues: {
            pullRequestApprovalActive: { value: false, level: "global" },
            riskAssessmentActive: { value: true, level: "global" },
            approvalPolicies: { value: policies, level: "global" },
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
const mount = (props: Parameters<typeof Settings>[0] = {}) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <Settings {...props} />
        </QueryClientProvider>,
    );
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
])("saves named policy changes in the current scope: %j", async (scope) => {
    mount(scope);
    fireEvent.click(screen.getByRole("switch", { name: "Enable Docs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({
        approvalPolicies: [{ ...docs, enabled: false }],
    });
    expect(
        screen.getByRole("switch", { name: "Automatic PR approval" }),
    ).not.toBeChecked();
});

it("keeps risk in its own screen and never enables automatic approval when policies change", () => {
    mount();
    expect(
        screen.queryByRole("switch", { name: "Assess PR risk" }),
    ).not.toBeInTheDocument();
    expect(
        screen.getByText(/Risk found or unavailable blocks approval/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Docs" }));
    expect(
        screen.getByRole("switch", { name: "Automatic PR approval" }),
    ).not.toBeChecked();
});

it("shows All clean PRs immediately when the last filter is removed, without another all-PRs control", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
        within(dialog).getByRole("button", {
            name: "Remove pr labels condition",
        }),
    );
    expect(within(dialog).getByText("All clean PRs")).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(screen.getByText("All clean PRs")).toBeInTheDocument();
});

it("starts a new policy disabled and shows its unrestricted scope before applying", () => {
    mount({ policies: [] });
    fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
        target: { value: "Small changes" },
    });
    expect(within(dialog).getByText("All clean PRs")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(
        screen.getByRole("switch", { name: "Enable Small changes" }),
    ).not.toBeChecked();
    expect(
        screen.getByRole("switch", { name: "Automatic PR approval" }),
    ).not.toBeChecked();
});

it("does not apply an empty or duplicate policy name", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
    const dialog = screen.getByRole("dialog");
    expect(
        within(dialog).getByRole("button", { name: "Apply" }),
    ).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
        target: { value: "docs" },
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "distinct policy name",
    );
    expect(
        within(dialog).getByRole("button", { name: "Apply" }),
    ).toBeDisabled();
});

it("preserves the chosen policy order when saving", async () => {
    const second = {
        id: "bots",
        name: "Bots",
        enabled: true,
        authors: ["dependabot[bot]"],
    };
    mount({ policies: [docs, second] });
    fireEvent.click(screen.getByRole("button", { name: "Move Bots up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ approvalPolicies: [second, docs] });
});

it("preserves explicit deletion instead of recreating an unrestricted policy", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
    expect(screen.getByText(/No policies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ approvalPolicies: [] });
});

it("does not allow policy mutations without settings permission", () => {
    mount({ disabled: true });
    expect(screen.getByRole("button", { name: "Add policy" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Enable Docs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Docs" })).toBeDisabled();
});
