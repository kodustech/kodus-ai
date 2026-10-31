import { AxiosError, AxiosHeaders } from "axios";

import { extractRejectionMessage } from "./extract-error-message";

const httpError = (status: number, data: unknown) =>
    new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
        status,
        statusText: "",
        data,
        headers: {},
        config: { headers: new AxiosHeaders() },
    });

describe("extractRejectionMessage", () => {
    it("returns the API's message when it rejects the input", () => {
        // The BYOK probe's answer for a base URL that carries the endpoint path.
        const message =
            'Base URL must not include the "/chat/completions" endpoint — the provider appends it. Use "https://api.together.ai/v1" instead.';

        expect(
            extractRejectionMessage(
                httpError(400, { statusCode: 400, message }),
            ),
        ).toBe(message);
    });

    it("returns nothing for a server fault", () => {
        expect(
            extractRejectionMessage(
                httpError(500, { message: "An unexpected error occurred" }),
            ),
        ).toBeUndefined();
    });

    it("returns nothing when the request never got an answer", () => {
        expect(
            extractRejectionMessage(new AxiosError("Network Error")),
        ).toBeUndefined();
        expect(extractRejectionMessage(new Error("boom"))).toBeUndefined();
    });
});
