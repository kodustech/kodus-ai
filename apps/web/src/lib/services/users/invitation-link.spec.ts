import { invitationLinkFailure } from "./invitation-link";

describe("invitationLinkFailure", () => {
    it("says there is no open invitation only when the API says so (404)", () => {
        expect(invitationLinkFailure({ response: { status: 404 } }).title).toBe(
            "No open invitation",
        );
    });

    it("asks to retry when the API did not answer", () => {
        for (const error of [
            { response: { status: 500 } },
            { response: { status: 403 } },
            new Error("Network Error"),
            undefined,
        ]) {
            expect(invitationLinkFailure(error)).toEqual({
                title: "Could not get the invite link",
                description: "Try again in a moment.",
            });
        }
    });
});
