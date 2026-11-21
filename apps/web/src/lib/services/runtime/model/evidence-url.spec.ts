import { checkEvidenceUrl } from "./evidence-url";

const appOrigin = "https://app.kodus.io";

describe("checkEvidenceUrl", () => {
    it("accepts an https URL on the isolated evidence origin", () => {
        expect(
            checkEvidenceUrl(
                "https://evidence.kodus.io/org/run/pr/s1/output?sig=x",
                { appOrigin },
            ),
        ).toEqual({
            ok: true,
            url: "https://evidence.kodus.io/org/run/pr/s1/output?sig=x",
        });
    });

    it("refuses script, data and plain http URLs", () => {
        for (const url of [
            "javascript:alert(document.domain)",
            "data:text/html,<script>alert(1)</script>",
            "http://evidence.kodus.io/x",
            "file:///etc/passwd",
        ]) {
            expect(checkEvidenceUrl(url, { appOrigin }).ok).toBe(false);
        }
    });

    it("refuses this app's own origin and credentials in the URL", () => {
        expect(
            checkEvidenceUrl("https://app.kodus.io/settings", { appOrigin }).ok,
        ).toBe(false);
        expect(
            checkEvidenceUrl("https://u:p@evidence.kodus.io/x", { appOrigin })
                .ok,
        ).toBe(false);
    });

    it("keeps to the allowlist when one is configured", () => {
        const allowedOrigins = ["https://evidence.kodus.io"];
        expect(
            checkEvidenceUrl("https://evidence.kodus.io/x", {
                appOrigin,
                allowedOrigins,
            }).ok,
        ).toBe(true);
        expect(
            checkEvidenceUrl("https://evil.example/x", {
                appOrigin,
                allowedOrigins,
            }),
        ).toMatchObject({ ok: false });
    });

    it("allows plain http only for a local evidence server", () => {
        expect(
            checkEvidenceUrl("http://localhost:3010/x", {
                appOrigin: "http://localhost:3000",
            }).ok,
        ).toBe(true);
    });

    it("refuses anything that is not a URL string", () => {
        expect(checkEvidenceUrl(undefined, { appOrigin }).ok).toBe(false);
        expect(checkEvidenceUrl("/relative/path", { appOrigin }).ok).toBe(
            false,
        );
        expect(checkEvidenceUrl({ url: "x" }, { appOrigin }).ok).toBe(false);
    });
});
