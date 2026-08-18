import { describe, expect, it } from "@jest/globals";

import { SELF_HOSTED_TRIAL_REQUEST_URL } from "../_constants/trial";
import { buildTrialRequestUrl } from "./trial-request";

describe("buildTrialRequestUrl", () => {
    it("prefills the context we already know", () => {
        const url = new URL(
            buildTrialRequestUrl({
                organizationId: "org-123",
                email: "dev@acme.com",
                version: "1.4.2",
            }),
        );

        expect(url.searchParams.get("org_id")).toBe("org-123");
        expect(url.searchParams.get("email")).toBe("dev@acme.com");
        expect(url.searchParams.get("version")).toBe("1.4.2");
    });

    it("points at our own domain, not the form provider", () => {
        expect(buildTrialRequestUrl()).toMatch(/^https:\/\/kodus\.io\//);
    });

    it("omits missing values instead of sending them empty", () => {
        // The version fetch is best-effort and the session may still be
        // loading — a partial context must still produce a usable link.
        const url = buildTrialRequestUrl({ organizationId: "org-123" });

        expect(url).toBe(`${SELF_HOSTED_TRIAL_REQUEST_URL}?org_id=org-123`);
        expect(url).not.toContain("email");
        expect(url).not.toContain("undefined");
    });

    it("drops whitespace-only values", () => {
        expect(
            buildTrialRequestUrl({ organizationId: "   ", email: "  " }),
        ).toBe(SELF_HOSTED_TRIAL_REQUEST_URL);
    });

    it("returns a bare url when nothing is known", () => {
        expect(buildTrialRequestUrl()).toBe(SELF_HOSTED_TRIAL_REQUEST_URL);
        expect(buildTrialRequestUrl({})).toBe(SELF_HOSTED_TRIAL_REQUEST_URL);
    });

    it("encodes values that are unsafe in a query string", () => {
        const url = new URL(
            buildTrialRequestUrl({ email: "dev+kodus@acme.com" }),
        );

        // `+` must survive the round trip rather than decoding to a space.
        expect(url.searchParams.get("email")).toBe("dev+kodus@acme.com");
    });
});
