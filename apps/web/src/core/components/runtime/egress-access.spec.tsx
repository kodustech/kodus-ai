/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useRevokeEgressHost } from "@services/runtime/queries";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EgressApprovalsList } from "./egress-access";

jest.mock("@services/runtime/queries", () => ({
    useRevokeEgressHost: jest.fn(),
    useApproveEgressHost: jest.fn(),
    useOrgEgress: jest.fn(),
    useUpdateOrgEgressSettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useRevokeEgressHost as jest.Mock).mockReturnValue({ mutate, isPending: false });
});

// G3 and D5 on the environment page: each approval says its tier and last use, and Revoke takes a second click.
describe("EgressApprovalsList", () => {
    const approvals = [
        { host: "cdn.vendor.example", mode: "inspected" as const, pathPrefixes: ["/dist/"], approvedAt: "2026-11-13T10:00:00.000Z", lastSentAt: "2026-11-13T11:00:00.000Z" },
        { host: "api.vendor.example", mode: "passthrough" as const, approvedAt: "2026-11-12T10:00:00.000Z" },
        { host: "gone.example", mode: "inspected" as const, approvedAt: "2026-11-11T10:00:00.000Z", revokedAt: "2026-11-12T10:00:00.000Z" },
    ];

    it("shows the tier and the last use, and revokes after a confirming click", () => {
        render(<EgressApprovalsList scopeId="env-1" approvals={approvals} canChange />);
        const cdn = screen.getByRole("listitem", { name: "cdn.vendor.example" });
        expect(within(cdn).getByText("Reads only under /dist/")).toBeInTheDocument();
        expect(within(cdn).getByText(/Last used/)).toBeInTheDocument();
        expect(within(screen.getByRole("listitem", { name: "api.vendor.example" })).getByText("Full access")).toBeInTheDocument();
        expect(within(screen.getByRole("listitem", { name: "gone.example" })).queryByRole("button")).not.toBeInTheDocument();
        fireEvent.click(within(cdn).getByRole("button", { name: "Revoke cdn.vendor.example" }));
        expect(mutate).not.toHaveBeenCalled();
        fireEvent.click(within(cdn).getByRole("button", { name: "Confirm revoking cdn.vendor.example" }));
        expect(mutate).toHaveBeenCalledWith({ environmentId: "env-1", host: "cdn.vendor.example" }, expect.anything());
    });

    it("offers no revoke to a reader", () => {
        render(<EgressApprovalsList scopeId="env-1" approvals={approvals} canChange={false} />);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
});
