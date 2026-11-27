/** @jest-environment jsdom */
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AxiosError } from "axios";

import { BitbucketTokenModal } from "./bitbucket";

// The Data Center switch measures its size in the browser.
globalThis.ResizeObserver ??= class {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
};

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@services/codeManagement/fetch", () => ({
    createCodeManagementIntegration: jest.fn(),
}));
jest.mock("@components/ui/magic-modal", () => ({
    magicModal: { lock: jest.fn(), unlock: jest.fn(), hide: jest.fn() },
    useMagicModalState: () => ({ closeable: true }),
}));
jest.mock("@components/ui/kody-review-preview", () => ({
    KodyReviewPreview: () => null,
}));
jest.mock("src/core/components/system/git-token-docs", () => ({
    GitTokenDocs: () => null,
}));

it.each([
    [
        400,
        "Could not connect to Bitbucket Data Center. Check the server URL and credentials, then try again.",
    ],
    [
        500,
        "Could not save the Bitbucket Data Center connection. Please try again.",
    ],
] as const)(
    "shows a safe Data Center error for HTTP %i and allows retrying the same fields",
    async (status, expectedMessage) => {
        mockPush.mockClear();
        const message = "Upstream diagnostic with private details";
        const create = jest.mocked(createCodeManagementIntegration);
        create.mockRejectedValueOnce(
            Object.assign(new AxiosError(message), {
                status,
                response: { status, data: { message } },
            }),
        );
        create.mockResolvedValueOnce({
            data: { success: true, status: "SUCCESS" },
            statusCode: 201,
        });
        render(
            <BitbucketTokenModal
                teamId="team-1"
                userId="user-1"
                userEmail="user@example.test"
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: /Bitbucket Data Center/ }),
        );
        for (const [placeholder, value] of [
            ["Enter your Data Center username", "reviewer"],
            ["https://bitbucket.your-company.com", "https://git.example.test"],
            ["Enter your Data Center password", "password"],
        ]) {
            fireEvent.change(screen.getByPlaceholderText(placeholder), {
                target: { value },
            });
        }

        const save = screen.getByRole<HTMLButtonElement>("button", {
            name: "Validate and save",
        });
        await waitFor(() => expect(save.disabled).toBe(false));
        fireEvent.click(save);
        expect((await screen.findByRole("alert")).textContent).toBe(
            expectedMessage,
        );
        expect(screen.queryByText(message)).toBeNull();
        expect(mockPush).not.toHaveBeenCalled();
        expect(save.disabled).toBe(false);

        fireEvent.click(save);
        await waitFor(() =>
            expect(mockPush).toHaveBeenCalledWith(
                "/setup/choosing-repositories",
            ),
        );
    },
);
