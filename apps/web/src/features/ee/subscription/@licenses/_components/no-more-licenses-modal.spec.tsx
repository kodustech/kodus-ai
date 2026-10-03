/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { NoMoreLicensesModal } from "./no-more-licenses-modal";

const mockSelfHosted = { value: false };
const mockCreateBillingLink = jest.fn();

jest.mock("src/core/utils/self-hosted", () => ({
    get isSelfHosted() {
        return mockSelfHosted.value;
    },
}));
jest.mock("../../_actions/create-manage-billing-link", () => ({
    createManageBillingLinkAction: (...args: unknown[]) =>
        mockCreateBillingLink(...args),
}));

describe("NoMoreLicensesModal", () => {
    it("on self-hosted, points at the license key, not a billing portal", () => {
        mockSelfHosted.value = true;

        render(<NoMoreLicensesModal teamId="team-1" seats={3} />);

        expect(screen.getByText("No seats left")).toBeInTheDocument();
        expect(screen.getByText(/covers 3 seats/)).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /manage licenses/i }),
        ).not.toBeInTheDocument();
    });

    it("says seat, singular, for a one-seat license", () => {
        mockSelfHosted.value = true;

        render(<NoMoreLicensesModal teamId="team-1" seats={1} />);

        expect(screen.getByText(/covers 1 seat,/)).toBeInTheDocument();
    });

    it("on cloud, offers to manage the plan's licenses", () => {
        mockSelfHosted.value = false;

        render(<NoMoreLicensesModal teamId="team-1" seats={3} />);

        expect(screen.getByText("You need more licenses")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /manage licenses/i }),
        ).toBeInTheDocument();
    });
});
