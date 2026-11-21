/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { usePermission } from "@services/permissions/hooks";
import { render, screen } from "@testing-library/react";

import { RuntimeOrgSettingsPage } from "./_page-component";

jest.mock("@services/permissions/hooks", () => ({ usePermission: jest.fn() }));
jest.mock("@services/runtime/queries", () => ({
    useRuntimeSettings: () => ({
        data: {
            tokenBudgetPerDay: null,
            exercisedLinesThresholdDefaultPercent: 50,
            exercisedLinesThresholdPercent: null,
            machineUsdPerHostHour: null,
            repositories: [{ repositoryId: "r", whoCanAsk: "writers" }],
        },
        isLoading: false,
        isError: false,
    }),
    useUpdateRuntimeOrgSettings: () => ({ mutate: jest.fn() }),
    useStopRuntime: () => ({ mutate: jest.fn() }),
    useResumeRuntime: () => ({ mutate: jest.fn() }),
}));
jest.mock("@components/runtime/runtime-header", () => ({
    RuntimeHeader: () => null,
}));
jest.mock("@components/runtime/egress-access", () => ({
    OutboundAccessSection: () => null,
}));
jest.mock("@components/runtime/runtime-secrets", () => ({
    RuntimeSecretsSection: () => null,
}));
jest.mock("@components/runtime/preview-settings", () => ({
    RuntimePreviewSettingsSection: () => null,
}));
jest.mock("@components/runtime/sandbox-capacity", () => ({
    SandboxCapacitySection: () => null,
}));
jest.mock("@components/runtime/exercised-lines-threshold", () => ({
    ExercisedLinesThreshold: () => null,
}));
jest.mock("@components/runtime/machine-host-price", () => ({
    MachineHostPrice: () => null,
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

describe("the Runtime settings page", () => {
    beforeEach(() => (usePermission as jest.Mock).mockReturnValue(true));

    it("no longer holds the repositories table or the machine time card", () => {
        render(<RuntimeOrgSettingsPage />);

        expect(
            screen.queryByRole("region", { name: "Repositories" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("region", { name: "Machine time" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        expect(
            screen.getByRole("region", { name: "Token budget" }),
        ).toBeInTheDocument();
    });

    it("points to where they went", () => {
        render(<RuntimeOrgSettingsPage />);

        expect(
            screen.getByRole("link", { name: "Code Review > Routing" }),
        ).toHaveAttribute("href", "/settings/code-review/global/routing");
        expect(screen.getByRole("link", { name: "Usage" })).toHaveAttribute(
            "href",
            "/token-usage?tab=runtime",
        );
    });

    it("opens the usage card on the Runtime tab of Usage", () => {
        render(<RuntimeOrgSettingsPage />);

        expect(
            screen.getByRole("link", { name: "Open usage" }),
        ).toHaveAttribute("href", "/token-usage?tab=runtime");
    });
});
