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
    {
        failure: "HTTP 400",
        status: 400,
        expectedMessage:
            "Could not connect to Bitbucket Data Center. Check the server URL and credentials, then try again.",
    },
    {
        failure: "HTTP 500",
        status: 500,
        expectedMessage:
            "Could not confirm the Bitbucket Data Center connection. Please try again.",
    },
    {
        failure: "a network error",
        status: undefined,
        expectedMessage:
            "Could not confirm the Bitbucket Data Center connection. Please try again.",
    },
])(
    "shows a safe Data Center error for $failure and allows retrying the same fields",
    async ({ status, expectedMessage }) => {
        mockPush.mockClear();
        const message = "Upstream diagnostic with private details";
        const create = jest.mocked(createCodeManagementIntegration).mockReset();
        const error = new AxiosError(message);
        if (status !== undefined) {
            Object.assign(error, {
                status,
                response: { status, data: { message } },
            });
        }
        create.mockRejectedValueOnce(error);
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
        const submission = {
            integrationType: "BITBUCKET",
            authMode: "basic",
            token: "password",
            organizationAndTeamData: { teamId: "team-1" },
            username: "reviewer",
            email: undefined,
            host: "https://git.example.test",
        };
        expect(create.mock.calls).toStrictEqual([[submission], [submission]]);
    },
);
