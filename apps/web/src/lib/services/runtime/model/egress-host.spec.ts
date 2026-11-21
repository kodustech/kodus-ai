import { checkEgressHost } from "./egress-host";

describe("checkEgressHost", () => {
    it("accepts a domain name, lowercased and trimmed", () => {
        expect(checkEgressHost(" API.Stripe.com ")).toEqual({
            ok: true,
            host: "api.stripe.com",
        });
    });

    it("refuses what the API refuses: IPs, wildcards, URLs, localhost", () => {
        for (const bad of [
            "169.254.169.254",
            "10.0.0.1",
            "[::1]",
            "*.example.com",
            "http://x.com/a",
            "localhost",
            "a..b",
            "-a.com",
            "",
        ]) {
            expect(checkEgressHost(bad).ok).toBe(false);
        }
        expect(checkEgressHost("169.254.169.254")).toMatchObject({
            error: "Approve a domain, not an IP address.",
        });
    });
});
