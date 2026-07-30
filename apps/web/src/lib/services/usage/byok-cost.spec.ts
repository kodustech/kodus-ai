import { canonicalModelId, resolveByokModelCost } from "./byok-cost";
import type { EnrichedModelUsage, PricingSource } from "./types";

function row(
    model: string,
    total: number,
    pricingSource: PricingSource = "catalog",
): EnrichedModelUsage {
    return {
        model,
        input: 0,
        output: 0,
        total: 0,
        outputReasoning: 0,
        pricingSource,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    };
}

describe("canonicalModelId", () => {
    it("returns clean ids unchanged", () => {
        expect(canonicalModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    });

    it("strips a provider prefix (last segment after ':')", () => {
        // Real G1b value: the LangChain path writes `provider:model`.
        expect(canonicalModelId("openai_compatible:kimi-k2.7-code")).toBe(
            "kimi-k2.7-code",
        );
    });

    it("trims and tolerates null/empty", () => {
        expect(canonicalModelId("  gpt-4o  ")).toBe("gpt-4o");
        expect(canonicalModelId(null)).toBe("");
        expect(canonicalModelId(undefined)).toBe("");
        expect(canonicalModelId("")).toBe("");
    });
});

describe("resolveByokModelCost", () => {
    it("matches a clean model id (Gemini — real G1b data)", () => {
        const byModel = [row("gemini-2.5-flash", 1.23), row("gemini-2.5-pro", 9)];
        expect(resolveByokModelCost("gemini-2.5-flash", byModel)).toMatchObject({
            status: "ok",
            total: 1.23,
            model: "gemini-2.5-flash",
            pricingSource: "catalog",
        });
    });

    it("reconciles the provider-prefixed row to the clean BYOK id (Kimi — real G1b data)", () => {
        // Backend already canonicalizes `openai_compatible:kimi-k2.7-code` to
        // `kimi-k2.7-code` in byModel; BYOK stores the clean id.
        const byModel = [row("kimi-k2.7-code", 4.5)];
        const res = resolveByokModelCost("kimi-k2.7-code", byModel);
        expect(res).toMatchObject({ status: "ok", total: 4.5 });
    });

    it("does NOT match gpt-4o against gpt-4o-mini (family safety, no startsWith)", () => {
        const byModel = [row("gpt-4o-mini", 7)];
        expect(resolveByokModelCost("gpt-4o", byModel)).toEqual({
            status: "no-data",
            reason: "no-usage",
        });
    });

    it("returns no-data (not $0) for a versioned provider id it cannot reconcile", () => {
        // OpenAI/Anthropic return date-versioned ids; the `:`-split can't map
        // `gpt-4o-2024-08-06` back to `gpt-4o`. Graceful degradation, never a
        // misleading $0. (Fast-follow T1a/T1b will make these exact.)
        const byModel = [row("gpt-4o-2024-08-06", 12.5)];
        expect(resolveByokModelCost("gpt-4o", byModel)).toEqual({
            status: "no-data",
            reason: "no-usage",
        });
    });

    it("returns no-data/unpriced when the row is present but pricingSource is missing", () => {
        const byModel = [row("gemini-2.5-flash", 0, "missing")];
        expect(resolveByokModelCost("gemini-2.5-flash", byModel)).toEqual({
            status: "no-data",
            reason: "unpriced",
        });
    });

    it("returns no-data for empty/undefined config or empty byModel", () => {
        expect(resolveByokModelCost("", [row("gemini-2.5-flash", 1)])).toEqual({
            status: "no-data",
            reason: "no-usage",
        });
        expect(resolveByokModelCost("gemini-2.5-flash", [])).toEqual({
            status: "no-data",
            reason: "no-usage",
        });
        expect(resolveByokModelCost("gemini-2.5-flash", undefined)).toEqual({
            status: "no-data",
            reason: "no-usage",
        });
    });

    it("preserves a real zero cost as OK (priced, genuinely $0 usage) — distinct from no-data", () => {
        const byModel = [row("gemini-2.5-flash", 0, "catalog")];
        expect(resolveByokModelCost("gemini-2.5-flash", byModel)).toMatchObject({
            status: "ok",
            total: 0,
            model: "gemini-2.5-flash",
            pricingSource: "catalog",
        });
    });
});
