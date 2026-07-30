import { isFeaturedSlug, isJobId, UUID_RE } from "./jobId";

describe("jobId / featured-slug detection", () => {
    const UUID_LOWER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const UUID_UPPER = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";

    describe("isJobId", () => {
        it("accepts a canonical UUID (lowercase)", () => {
            expect(isJobId(UUID_LOWER)).toBe(true);
        });

        it("accepts a UUID regardless of case", () => {
            expect(isJobId(UUID_UPPER)).toBe(true);
        });

        it("rejects a featured slug", () => {
            expect(isJobId("react-fizz-resume-abort")).toBe(false);
        });

        it("rejects an empty string", () => {
            expect(isJobId("")).toBe(false);
        });

        it("rejects a UUID with surrounding text (anchored match)", () => {
            expect(isJobId(`x${UUID_LOWER}`)).toBe(false);
            expect(isJobId(`${UUID_LOWER} `)).toBe(false);
        });
    });

    describe("isFeaturedSlug", () => {
        it("is the inverse of isJobId for a UUID", () => {
            expect(isFeaturedSlug(UUID_LOWER)).toBe(false);
        });

        it("treats hyphenated slugs as featured", () => {
            expect(isFeaturedSlug("trpc-error-handling-vm")).toBe(true);
            expect(isFeaturedSlug("supabase-cron-job-id")).toBe(true);
        });

        it("treats an empty id as a (non-job) slug", () => {
            // /r/ with no UUID falls through to the featured loader rather
            // than starting a poll against a non-existent job.
            expect(isFeaturedSlug("")).toBe(true);
        });
    });

    it("UUID_RE is anchored at both ends", () => {
        expect(UUID_RE.source.startsWith("^")).toBe(true);
        expect(UUID_RE.source.endsWith("$")).toBe(true);
    });
});
