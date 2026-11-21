/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { usePermission } from "@services/permissions/hooks";
import type { RuntimeRepositorySettings } from "@services/runtime/contracts";
import {
    useRuntimeEnvironments,
    useRuntimeSettings,
    useUpdateRuntimeRepositorySettings,
} from "@services/runtime/queries";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RuntimeRoutingSection } from "./repository-runtime-settings";

jest.mock("@services/permissions/hooks", () => ({ usePermission: jest.fn() }));
jest.mock("@services/runtime/queries", () => ({
    useRuntimeSettings: jest.fn(),
    useRuntimeEnvironments: jest.fn(),
    useUpdateRuntimeRepositorySettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const mutate = jest.fn();
const repositories: RuntimeRepositorySettings[] = [
    {
        repositoryId: "repo-1",
        repositoryName: "acme/shop",
        mode: "on_request",
        whoCanAsk: "writers",
    },
    {
        repositoryId: "repo-2",
        repositoryName: "acme/api",
        mode: "off",
        whoCanAsk: "maintainers",
    },
];

beforeAll(() => {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    HTMLElement.prototype.scrollIntoView = jest.fn();
});
beforeEach(() => {
    mutate.mockReset();
    (usePermission as jest.Mock).mockReturnValue(true);
    (useRuntimeSettings as jest.Mock).mockReturnValue({
        data: { repositories },
        isLoading: false,
        isError: false,
    });
    (useRuntimeEnvironments as jest.Mock).mockReturnValue({ data: [] });
    (useUpdateRuntimeRepositorySettings as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

describe("the Kody Runtime section of Code Review routing", () => {
    it("lists every repository with its two selects on the global page", () => {
        render(<RuntimeRoutingSection repositoryId="global" />);

        const rows = screen.getAllByRole("row").slice(1);
        expect(rows).toHaveLength(2);
        expect(
            screen.getAllByRole("columnheader").map((h) => h.textContent),
        ).toEqual(["Repository", "Runs", "Who may ask @kody runtime"]);
        expect(within(rows[0]).getByText("acme/shop")).toHaveAttribute(
            "href",
            "/settings/code-review/repo-1/kody-runtime",
        );
        expect(
            within(rows[0]).getByRole("combobox", {
                name: "When Kody Runtime runs on acme/shop",
            }),
        ).toHaveTextContent("On request");
        expect(
            within(rows[0]).getByRole("combobox", {
                name: "Who may ask @kody runtime on acme/shop",
            }),
        ).toHaveTextContent("Anyone with write access");
    });

    it("saves a change of a row through the repository settings mutation", async () => {
        render(<RuntimeRoutingSection repositoryId="global" />);

        fireEvent.click(
            screen.getByRole("combobox", {
                name: "Who may ask @kody runtime on acme/shop",
            }),
        );
        fireEvent.click(
            await screen.findByRole("option", {
                name: "Maintainers and admins",
            }),
        );

        expect(mutate).toHaveBeenCalledWith(
            { repositoryId: "repo-1", whoCanAsk: "maintainers" },
            expect.any(Object),
        );
    });

    it("shows only the repository's own two selects on a repository page", () => {
        render(<RuntimeRoutingSection repositoryId="repo-2" />);

        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        expect(
            screen.getByRole("combobox", {
                name: "When Kody Runtime runs on acme/api",
            }),
        ).toHaveTextContent("Off");
        // Off: nobody may ask, so that select waits for a mode.
        expect(
            screen.getByRole("combobox", {
                name: "Who may ask @kody runtime on acme/api",
            }),
        ).toBeDisabled();
        expect(screen.queryByText("acme/shop")).not.toBeInTheDocument();
    });

    it("saves the repository's mode through the same mutation", async () => {
        render(<RuntimeRoutingSection repositoryId="repo-1" />);

        fireEvent.click(
            screen.getByRole("combobox", {
                name: "When Kody Runtime runs on acme/shop",
            }),
        );
        fireEvent.click(await screen.findByRole("option", { name: "Off" }));

        expect(mutate).toHaveBeenCalledWith(
            { repositoryId: "repo-1", mode: "off" },
            expect.any(Object),
        );
    });

    it("disables the selects of whoever may not edit the repository", () => {
        (usePermission as jest.Mock).mockReturnValue(false);
        render(<RuntimeRoutingSection repositoryId="repo-1" />);
        expect(
            screen.getByRole("combobox", {
                name: "When Kody Runtime runs on acme/shop",
            }),
        ).toBeDisabled();
    });

    it("never shows a table of defaults when the settings cannot be read", () => {
        (useRuntimeSettings as jest.Mock).mockReturnValue({
            data: undefined,
            isLoading: false,
            isError: true,
            error: new Error("boom"),
            refetch: jest.fn(),
        });
        render(<RuntimeRoutingSection repositoryId="global" />);
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });
});
