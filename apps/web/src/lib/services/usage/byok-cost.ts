import type { EnrichedModelUsage, PricingSource } from "./types";

/**
 * Resolves the accumulated cost of a BYOK-configured model from the
 * `/usage/tokens/summary` `byModel` rows.
 *
 * Correctness notes (see .planning/features/1395-byok-cost/PLAN.md):
 * - The backend stores usage under a *canonical* model id derived from
 *   `gen_ai.response.model` via `split(':').pop()` (strips a `provider:` prefix
 *   added by `resolveModelName`). BYOK config stores the clean model id. We
 *   canonicalize both sides the same way before matching.
 * - `byModel` already carries exactly one row per canonical model
 *   (backend `_mergeTierRows`), so an exact-equality `find` is correct and
 *   never under-counts across tiers.
 * - Matching is EXACT on the canonical id — deliberately NOT `startsWith` —
 *   so `gpt-4o` never captures `gpt-4o-mini`.
 * - When the provider returns a versioned id (`gpt-4o-2024-08-06`) that the
 *   canonical form can't reconcile to the clean BYOK id, we report
 *   `no-data` rather than a misleading `$0`. Same for unpriced rows
 *   (`pricingSource === 'missing'`). "Never show a wrong number."
 */

export type ByokModelCost =
    | {
          status: "ok";
          model: string;
          pricingSource: PricingSource;
          /** Total USD cost (kept flat for the compact chip). */
          total: number;
          /** USD cost split by token type, for the detailed breakdown. */
          costInput: number;
          costOutput: number;
          /** Token counts, so the chip can show usage, not just dollars. */
          tokensInput: number;
          tokensOutput: number;
          tokensTotal: number;
      }
    | { status: "no-data"; reason: "no-usage" | "unpriced" };

/**
 * Canonical model id — the web mirror of the backend
 * `@libs/common/utils/canonical-model` (kept as its own copy because apps/web
 * can't import a value from `@libs/*` without breaking the isolated prod build;
 * keep the two in lockstep). Strips a trailing `:<digits>` VERSION suffix
 * (Amazon Bedrock's `...v1:0` → `...v1`, never `"0"`, which would collapse every
 * Bedrock model onto one bucket and never match the configured id) and a leading
 * `provider:` PREFIX (`anthropic:claude-opus-5` → `claude-opus-5`).
 */
export function canonicalModelId(model: string | null | undefined): string {
    const stripped = (model ?? "").trim().replace(/:\d+$/, "");
    return (stripped.split(":").pop() ?? "").trim();
}

/**
 * Resolve the cost for a single BYOK model against the summary's `byModel`.
 * Returns `no-data` (never `$0`) when the model can't be matched or priced.
 */
export function resolveByokModelCost(
    configModel: string | null | undefined,
    byModel: readonly EnrichedModelUsage[] | null | undefined,
): ByokModelCost {
    const target = canonicalModelId(configModel);
    if (!target) return { status: "no-data", reason: "no-usage" };

    const row = (byModel ?? []).find(
        (r) => canonicalModelId(r.model) === target,
    );
    if (!row) return { status: "no-data", reason: "no-usage" };
    if (row.pricingSource === "missing") {
        return { status: "no-data", reason: "unpriced" };
    }

    return {
        status: "ok",
        model: row.model,
        pricingSource: row.pricingSource,
        total: row.cost.total,
        costInput: row.cost.input,
        costOutput: row.cost.output,
        tokensInput: row.input,
        tokensOutput: row.output,
        tokensTotal: row.total,
    };
}
