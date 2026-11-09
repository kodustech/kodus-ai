/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { previewPrRisk } from "@services/risk-assessment/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";

import RiskPage from "./page";

jest.mock("@services/permissions/hooks", () => ({ usePermission: () => true }));
let mockAccess = true;
jest.mock("src/app/(app)/settings/_components/context", () => ({
    useFeatureFlags: () => ({ conditionalPrApproval: mockAccess }),
}));
jest.mock(
    "src/features/ee/subscription/_providers/subscription-context",
    () => ({
        useSubscriptionContext: () => ({
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: "teams_monthly",
            },
        }),
    }),
);
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team" }),
}));
jest.mock("../../../_hooks", () => ({
    useCodeReviewRouteParams: () => ({
        repositoryId: "repo",
        directoryId: undefined,
    }),
}));
jest.mock("../../_components/centralized-config-readonly-alert", () => ({
    CentralizedConfigReadOnlyAlert: () => null,
}));
jest.mock("../../_components/override", () => ({
    OverrideIndicatorForm: () => null,
}));
jest.mock("@services/codeManagement/hooks", () => ({
    useGetSelectedRepositories: () => ({ data: [] }),
}));
jest.mock("@services/risk-assessment/fetch", () => ({
    previewPrRisk: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
const saveSettings = jest.fn();
jest.mock("../../_hooks/use-code-review-settings-mutation", () => ({
    useCodeReviewSettingsMutation: () => ({ saveSettings }),
}));

type RiskTestForm = {
    riskAssessmentActive: { value: boolean; level: string };
    riskCriteria: {
        value: import("@services/risk-assessment/types").RiskCriterion[];
        level: string;
    };
    pullRequestApprovalActive: { value: boolean; level: string };
};
let currentForm: UseFormReturn<RiskTestForm>;
function setup(
    active = true,
    criteria: RiskTestForm["riskCriteria"]["value"] = [],
) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    function Host() {
        const form = useForm<RiskTestForm>({
            defaultValues: {
                riskAssessmentActive: { value: active, level: "global" },
                riskCriteria: { value: criteria, level: "global" },
                pullRequestApprovalActive: { value: false, level: "global" },
            },
        });
        currentForm = form;
        return (
            <QueryClientProvider client={queryClient}>
                <FormProvider {...form}>
                    <RiskPage />
                    <span data-testid="form-state">
                        {form.formState.isDirty ? "dirty" : "clean"}
                    </span>
                </FormProvider>
            </QueryClientProvider>
        );
    }
    return render(<Host />);
}

beforeEach(() => {
    jest.resetAllMocks();
    mockAccess = true;
    saveSettings.mockResolvedValue(undefined);
});

it.each([1, 2])(
    "preserves criterion deletion across refetch with %i saved criteria",
    async (count) => {
        const criteria = ["Access control", "Customer data"]
            .slice(-count)
            .map((name, index) => ({
                id: `criterion-${index}`,
                name,
                instructions: `Check ${name}.`,
                enabled: true,
            }));
        setup(true, criteria);
        const snapshot = JSON.parse(JSON.stringify(currentForm.getValues()));

        fireEvent.click(
            screen.getByRole("button", { name: "Delete Customer data" }),
        );
        expect(
            screen.queryByRole("heading", { name: "Customer data" }),
        ).toBeNull();
        expect(screen.getByTestId("form-state")).toHaveTextContent("dirty");

        act(() =>
            currentForm.reset(snapshot, {
                keepDirtyValues: true,
                keepDirty: true,
                keepErrors: true,
                keepTouched: true,
            }),
        );
        expect(
            screen.queryByRole("heading", { name: "Customer data" }),
        ).toBeNull();
        const remaining = criteria.slice(0, -1);
        expect(currentForm.getValues("riskCriteria.value")).toEqual(remaining);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Save settings" }),
            ).toBeEnabled(),
        );
        fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        const [data, options] = saveSettings.mock.calls[0];
        expect(options.prepare(data).codeReviewConfig.riskCriteria).toEqual(
            remaining,
        );
    },
);

it("always allows turning a saved assessment off after access is removed", async () => {
    mockAccess = false;
    setup(true);
    const toggle = screen.getByRole("switch", { name: "Risk assessment" });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(currentForm.getValues("riskAssessmentActive.value")).toBe(false);
    expect(toggle).toBeDisabled();
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Save settings" }),
        ).toBeEnabled(),
    );
});

it("allows risk with approval off and changes only the independent toggle", async () => {
    setup(false);
    fireEvent.click(screen.getByRole("switch", { name: "Risk assessment" }));
    expect(currentForm.getValues("riskAssessmentActive.value")).toBe(true);
    expect(currentForm.getValues("pullRequestApprovalActive.value")).toBe(
        false,
    );
    expect(screen.queryByText(/medium|low|high/i)).toBeNull();
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Save settings" }),
        ).toBeEnabled(),
    );
});

it("keeps criteria optional and saves only risk configuration", async () => {
    setup();
    expect(
        screen.getByText(
            "Kody uses the PR diff and code context. Add criteria to include your team’s context.",
        ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Risk assessment" }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Save settings" }),
        ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    const [data, options] = saveSettings.mock.calls[0];
    expect(options.prepare(data).codeReviewConfig).toEqual({
        riskAssessmentActive: false,
        riskCriteria: [],
    });
});

it("adds team guidance through the dialog without changing approval", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "Access control" },
    });
    fireEvent.change(screen.getByLabelText("What should Kody consider?"), {
        target: { value: "Check tenant isolation." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
        await screen.findByRole("heading", { name: "Access control" }),
    ).toBeInTheDocument();
    expect(currentForm.getValues("riskCriteria.value")).toEqual([
        expect.objectContaining({ name: "Access control", enabled: true }),
    ]);
    expect(currentForm.getValues("pullRequestApprovalActive.value")).toBe(
        false,
    );
});

it("previews real service results in the side panel without saving or publishing", async () => {
    jest.mocked(previewPrRisk).mockResolvedValue({
        assessment: {
            status: "assessed",
            riskIdentified: true,
            reason: "Tenant isolation can change.",
        },
        files: [],
    });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview on a PR" }));
    expect(
        screen.getByRole("dialog", { name: "Preview on a PR" }),
    ).toHaveAttribute("data-slot", "sheet-content");
    fireEvent.change(screen.getByLabelText("PR number"), {
        target: { value: "17" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview risk" }));
    expect(
        await screen.findByRole("heading", { name: "Risk found" }),
    ).toBeInTheDocument();
    expect(previewPrRisk).toHaveBeenCalledWith(
        { teamId: "team", repositoryId: "repo", prNumber: 17, criteria: [] },
        expect.anything(),
    );
    expect(saveSettings).not.toHaveBeenCalled();
});

it("edits and validates both file filters in one sheet and discards its draft on Cancel", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    const editor = screen.getByRole("dialog", { name: "Add criterion" });
    expect(editor).toHaveAttribute("data-slot", "sheet-content");
    for (const name of ["Included files", "Excluded files"]) {
        const section = within(editor).getByRole("region", { name });
        fireEvent.click(
            within(section).getByRole("button", {
                name: `Edit ${name.toLowerCase()}`,
            }),
        );
        const pattern = within(section).getByRole("textbox", {
            name: "Add or search file patterns",
        });
        fireEvent.change(pattern, { target: { value: "src/**" } });
        fireEvent.keyDown(pattern, { key: "Enter" });
        fireEvent.change(
            within(section).getByRole("textbox", { name: "Test a file" }),
            { target: { value: "src/auth.ts" } },
        );
        expect(within(section).getByText(/Matched by/)).toHaveTextContent(
            "src/**",
        );
    }
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(currentForm.getValues("riskCriteria.value")).toEqual([]);
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(currentForm.getValues("riskCriteria.value")).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
