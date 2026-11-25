/** @jest-environment jsdom */
import { render } from "@testing-library/react";

import InvitePage from "./page";

const mockGetInviteData = jest.fn();
jest.mock("src/lib/auth/fetchers", () => ({
    getInviteData: (token: string) => mockGetInviteData(token),
}));
const mockForm = jest.fn();
jest.mock("../../components/invite-form", () => ({
    AcceptInviteForm: (props: unknown) => {
        mockForm(props);
        return <div>invite form</div>;
    },
}));

const show = async (id: string) =>
    render(await InvitePage({ params: Promise.resolve({ id }) }));

/**
 * The invite link's path segment is the sealed invitation. A link the API
 * does not recognise says so; an API that cannot answer says to try again,
 * and the token never reaches a log line.
 */
describe("invite page", () => {
    beforeEach(() => jest.clearAllMocks());

    it("hands the decoded token to the API and the form", async () => {
        mockGetInviteData.mockResolvedValue({
            uuid: "u-1",
            email: "dev@example.test",
            organization: { name: "Acme" },
        });

        const { getByText } = await show("abc.def%3D");

        expect(mockGetInviteData).toHaveBeenCalledWith("abc.def=");
        expect(mockForm).toHaveBeenCalledWith(
            expect.objectContaining({
                email: "dev@example.test",
                inviteToken: "abc.def=",
            }),
        );
        expect(getByText("invite form")).toBeTruthy();
    });

    it("says the invitation is invalid when the API does not recognise it", async () => {
        mockGetInviteData.mockResolvedValue({});

        const { getByText } = await show("abc.def");

        expect(getByText("Invalid or expired invitation")).toBeTruthy();
        expect(mockForm).not.toHaveBeenCalled();
    });

    it("says the invitation is invalid for a link that cannot be decoded", async () => {
        const { getByText } = await show("%E0%A4%A");

        expect(getByText("Invalid or expired invitation")).toBeTruthy();
        expect(mockGetInviteData).not.toHaveBeenCalled();
    });

    it("asks to try again when the API cannot answer, without logging the token", async () => {
        const error = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            mockGetInviteData.mockRejectedValue(
                Object.assign(
                    new Error(
                        "Request error: 503 Service Unavailable in URL: /user/invite?token=secret.token",
                    ),
                    { statusCode: 503 },
                ),
            );

            const { getByText, queryByText } = await show("secret.token");

            expect(getByText("We could not load this invitation")).toBeTruthy();
            expect(queryByText("Invalid or expired invitation")).toBeNull();
            // Every logged argument, an Error's message and stack included
            // (JSON.stringify drops them).
            const logged = error.mock.calls
                .flat()
                .map((arg) =>
                    arg instanceof Error
                        ? `${arg.message} ${arg.stack}`
                        : typeof arg === "string"
                          ? arg
                          : JSON.stringify(arg),
                )
                .join(" ");
            expect(logged).not.toContain("secret.token");
        } finally {
            error.mockRestore();
        }
    });
});
