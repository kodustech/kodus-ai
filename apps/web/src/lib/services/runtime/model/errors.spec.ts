import { isNotFoundError, runtimeErrorMessage } from "./errors";

const apiError = (statusCode: number, body?: unknown) =>
    Object.assign(new Error("Request error"), { statusCode, body });

describe("runtimeErrorMessage", () => {
    const messages = {
        fallback: "Couldn't start a new run",
        409: "This Run is still going.",
    };

    it("uses the line written for the status first", () => {
        expect(
            runtimeErrorMessage(apiError(409, { message: "x" }), messages),
        ).toBe("This Run is still going.");
    });

    it("shows the API's own sentence for a client error", () => {
        expect(
            runtimeErrorMessage(
                apiError(403, {
                    statusCode: 403,
                    message: "The author of the pull request cannot approve it",
                }),
                messages,
            ),
        ).toBe("The author of the pull request cannot approve it");
        expect(
            runtimeErrorMessage(
                apiError(400, { data: { message: ["a", "b"] } }),
                messages,
            ),
        ).toBe("a b");
    });

    it("does not blame permissions for a network error or a 5xx", () => {
        expect(runtimeErrorMessage(new Error("Network error"), messages)).toBe(
            "Couldn't start a new run",
        );
        expect(
            runtimeErrorMessage(
                apiError(502, { message: "upstream" }),
                messages,
            ),
        ).toBe("Couldn't start a new run");
        expect(runtimeErrorMessage(apiError(403), messages)).toBe(
            "You do not have permission to do this here.",
        );
    });

    it("tells a 404 apart", () => {
        expect(isNotFoundError(apiError(404))).toBe(true);
        expect(isNotFoundError(apiError(500))).toBe(false);
        expect(isNotFoundError(null)).toBe(false);
    });
});
