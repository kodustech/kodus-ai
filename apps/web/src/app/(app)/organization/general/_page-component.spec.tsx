/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import {
    setFixedEgressIp,
    type FixedEgressIp,
} from "@services/organizationParameters/fixedEgressIp";
import {
    OrganizationParametersConfigKey,
    Timezone,
} from "@services/parameters/types";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { GeneralOrganizationSettingsPage } from "./_page-component";

jest.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: jest.fn() }),
}));
jest.mock("@services/organizationParameters/fetch", () => ({
    createOrUpdateOrganizationParameter: jest.fn().mockResolvedValue({}),
}));
jest.mock("src/core/utils/revalidate-server-side", () => ({
    revalidateServerSidePath: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("@services/organizationParameters/fixedEgressIp", () => ({
    setFixedEgressIp: jest.fn(),
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));
jest.mock("src/core/utils/self-hosted", () => ({ isSelfHosted: false }));

// Radix's Switch measures itself; jsdom has no ResizeObserver.
global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const NO_FIXED_IP: FixedEgressIp = {
    available: false,
    allowedByPlan: false,
    enabled: false,
};

const renderPage = (
    reviewCommandModes: {
        heavyBlocked: boolean;
        ultraBlocked: boolean;
    } | null = {
        heavyBlocked: false,
        ultraBlocked: false,
    },
    fixedEgressIp: FixedEgressIp = NO_FIXED_IP,
) =>
    render(
        <GeneralOrganizationSettingsPage
            email="owner@acme.dev"
            timezone={Timezone.NEW_YORK}
            autoJoinConfig={{ enabled: false, domains: ["acme.dev"] }}
            reviewCommandModes={reviewCommandModes ?? undefined}
            fixedEgressIp={fixedEgressIp}
        />,
    );

describe("General settings — review mode commands", () => {
    beforeEach(() => jest.clearAllMocks());

    it("shows both commands allowed when nothing is stored", () => {
        renderPage();
        expect(
            screen.getByRole("switch", {
                name: "Allow Heavy review by command",
            }),
        ).toBeChecked();
        expect(
            screen.getByRole("switch", {
                name: "Allow Ultra review by command",
            }),
        ).toBeChecked();
    });

    it("shows the switches unknown, and the rest of the page, when they could not be read", () => {
        renderPage(null, {
            available: true,
            allowedByPlan: true,
            enabled: false,
            fixedIp: "203.0.113.10",
        });
        expect(screen.getByRole("alert")).toHaveTextContent(
            "These settings could not be loaded.",
        );
        for (const name of [
            "Allow Heavy review by command",
            "Allow Ultra review by command",
        ]) {
            expect(screen.getByRole("switch", { name })).toBeDisabled();
        }
        // The rest of the page is still there, and still usable.
        expect(screen.getByLabelText("Timezone")).toBeInTheDocument();
        expect(
            screen.getByRole("switch", { name: "Auto join by email domain" }),
        ).toBeEnabled();
        expect(
            screen.getByRole("switch", { name: "Fixed outbound IP" }),
        ).toBeEnabled();
    });

    it("saves a command turned off as blocked, and only that parameter", async () => {
        renderPage({ heavyBlocked: true, ultraBlocked: false });
        expect(
            screen.getByRole("switch", {
                name: "Allow Heavy review by command",
            }),
        ).not.toBeChecked();

        fireEvent.click(
            screen.getByRole("switch", {
                name: "Allow Ultra review by command",
            }),
        );
        await act(async () => {
            fireEvent.submit(
                screen
                    .getByRole("switch", {
                        name: "Allow Ultra review by command",
                    })
                    .closest("form")!,
            );
        });

        expect(createOrUpdateOrganizationParameter).toHaveBeenCalledTimes(1);
        expect(createOrUpdateOrganizationParameter).toHaveBeenCalledWith(
            OrganizationParametersConfigKey.REVIEW_COMMAND_MODES_CONFIG,
            { heavyBlocked: true, ultraBlocked: true },
        );
    });
});

describe("General settings — fixed outbound IP", () => {
    beforeEach(() => jest.clearAllMocks());

    const paid: FixedEgressIp = {
        available: true,
        allowedByPlan: true,
        enabled: false,
        savedOn: false,
        inRollout: true,
        fixedIp: "203.0.113.10",
    };

    it("shows the organization's fixed outbound IP card on this page", () => {
        renderPage(undefined, paid);
        expect(screen.getByText("Fixed outbound IP")).toBeInTheDocument();
        expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    });

    it("copying the IP does not submit the page's form", async () => {
        renderPage(undefined, paid);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copy" }));
        });
        expect(createOrUpdateOrganizationParameter).not.toHaveBeenCalled();
    });

    it("saves the switch on its own, without the page's Save", async () => {
        (setFixedEgressIp as jest.Mock).mockResolvedValue({
            ...paid,
            enabled: true,
            savedOn: true,
        });
        renderPage(undefined, paid);
        await act(async () => {
            fireEvent.click(
                screen.getByRole("switch", { name: "Fixed outbound IP" }),
            );
        });
        expect(setFixedEgressIp).toHaveBeenCalledWith({ enabled: true });
        expect(createOrUpdateOrganizationParameter).not.toHaveBeenCalled();
    });
});
