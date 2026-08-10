import { http } from "./http.js";

/**
 * Check the review LLM BEFORE the matrix spends anything on it.
 *
 * Three consecutive runs were burned discovering at minute ~40 that the key
 * had no credit: the scenarios did exactly what they should — waited for a
 * review, got none, failed — and the verdict looked like a product regression.
 * One request costing a single token answers the same question up front.
 *
 * The failure classes are deliberately distinguished, because the fix for each
 * lives in a different place and the provider's own wording blurs them:
 *   auth    → the key is wrong/revoked        (rotate the secret)
 *   quota   → no balance, or a spend cap hit  (billing, or Project → Limits)
 *   model   → the id does not exist for this key (model name / entitlement)
 */
export type LlmPreflightStatus = "ok" | "auth" | "quota" | "model" | "unknown";

export interface LlmPreflightResult {
    status: LlmPreflightStatus;
    model: string;
    detail?: string;
}

/**
 * Classify a provider error body. Kept separate from the request so the
 * mapping is testable without a network — the whole point is that this call
 * must never be the thing that is unreliable.
 */
export function classifyLlmError(
    httpStatus: number,
    body: string,
): LlmPreflightStatus {
    const lower = (body ?? "").toLowerCase();
    // The request was accepted and the model ran; it just could not fit an
    // answer in the cap WE set. That says the key and the model are fine,
    // which is the whole question this probe asks.
    if (
        lower.includes("max_tokens or model output limit was reached") ||
        lower.includes("could not finish the message")
    ) {
        return "ok";
    }
    // Order matters: a 404 for an unknown model and a 401 for a bad key both
    // carry generic wording, so match on the specific codes first.
    if (
        lower.includes("insufficient_quota") ||
        lower.includes("no credits remaining") ||
        lower.includes("billing") ||
        lower.includes("exceeded your current quota")
    ) {
        return "quota";
    }
    if (
        lower.includes("model_not_found") ||
        lower.includes("does not exist") ||
        lower.includes("do not have access to")
    ) {
        return "model";
    }
    if (httpStatus === 401 || httpStatus === 403 || lower.includes("incorrect api key")) {
        return "auth";
    }
    if (httpStatus === 404) return "model";
    if (httpStatus === 429) return "quota";
    return "unknown";
}

export function describeLlmPreflight(r: LlmPreflightResult): string {
    switch (r.status) {
        case "ok":
            return `[preflight] LLM ok — ${r.model} answered`;
        case "auth":
            return `[preflight] LLM key REJECTED for ${r.model}. Rotate E2E_LLM_API_KEY; every review scenario will fail until then. Check it belongs to the vendor E2E_LLM_BASE_URL points at — a key sent to the wrong vendor is rejected exactly like a revoked one. ${r.detail ?? ""}`;
        case "quota":
            return `[preflight] LLM has NO BUDGET for ${r.model} — an empty balance and a hit spend cap produce the same error, so check BOTH billing and the project's monthly limit. Every review scenario will fail until then. ${r.detail ?? ""}`;
        case "model":
            return `[preflight] model '${r.model}' is not available to this key. Set vars.E2E_LLM_MODEL to one the account can use. ${r.detail ?? ""}`;
        default:
            return `[preflight] LLM check inconclusive for ${r.model}: ${r.detail ?? "unknown error"}`;
    }
}

/**
 * One-token completion against the configured provider. Returns `ok` when the
 * env is not configured at all — the caller decides whether that matters, and
 * a matrix with no review scenarios legitimately needs no LLM.
 */
export async function llmPreflight(
    env: NodeJS.ProcessEnv = process.env,
): Promise<LlmPreflightResult> {
    const key = env.API_OPEN_AI_API_KEY;
    const model = env.API_LLM_PROVIDER_MODEL ?? "gpt-5.4-mini";
    if (!key) {
        return { status: "ok", model, detail: "no key configured — skipped" };
    }
    const base = (env.API_OPENAI_FORCE_BASE_URL ?? "https://api.openai.com/v1")
        .replace(/\/$/, "");

    try {
        const resp = await http<unknown>(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: {
                model,
                messages: [{ role: "user", content: "ping" }],
                // Not 1. A reasoning model spends output budget before it
                // emits any text, so a 1-token cap returns HTTP 400 "could not
                // finish the message" — the probe failing on itself, which is
                // exactly the false alarm this file exists to prevent.
                max_completion_tokens: 64,
            },
            timeoutMs: 30_000,
        });
        if (resp.status >= 200 && resp.status < 300) {
            return { status: "ok", model };
        }
        return {
            status: classifyLlmError(resp.status, resp.raw),
            model,
            detail: `HTTP ${resp.status}: ${resp.raw.slice(0, 200)}`,
        };
    } catch (err) {
        // Network trouble is not a verdict about the key.
        return {
            status: "unknown",
            model,
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}
