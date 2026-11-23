/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
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

// Radix's Switch measures itself; jsdom has no ResizeObserver.
global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const renderPage = (
    reviewCommandModes: {
        heavyBlocked: boolean;
        ultraBlocked: boolean;
    } | null = {
        heavyBlocked: false,
        ultraBlocked: false,
    },
) =>
    render(
        <GeneralOrganizationSettingsPage
            email="owner@acme.dev"
            timezone={Timezone.NEW_YORK}
            autoJoinConfig={{ enabled: false, domains: ["acme.dev"] }}
            reviewCommandModes={reviewCommandModes ?? undefined}
        />,
    );

describe("General settings — review mode commands", () => {
    beforeEach(() => jest.clearAllMocks());

    it("shows both commands allowed when nothing is stored", () => {
        renderPage();
        expect(
            screen.getByRole("switch", {
                name: "Block Heavy review by command",
            }),
        ).not.toBeChecked();
        expect(
            screen.getByRole("switch", {
                name: "Block Ultra review by command",
            }),
        ).not.toBeChecked();
    });

    it("shows the switches unknown, and the rest of the page, when they could not be read", () => {
        renderPage(null);
        expect(screen.getByRole("alert")).toHaveTextContent(
            "These settings could not be loaded.",
        );
        for (const name of [
            "Block Heavy review by command",
            "Block Ultra review by command",
        ]) {
            expect(screen.getByRole("switch", { name })).toBeDisabled();
        }
    });

    it("saves the switch blocked, and only that parameter", async () => {
        renderPage({ heavyBlocked: true, ultraBlocked: false });
        expect(
            screen.getByRole("switch", {
                name: "Block Heavy review by command",
            }),
        ).toBeChecked();

        fireEvent.click(
            screen.getByRole("switch", {
                name: "Block Ultra review by command",
            }),
        );
        await act(async () => {
            fireEvent.submit(
                screen
                    .getByRole("switch", {
                        name: "Block Ultra review by command",
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
