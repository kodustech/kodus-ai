// BYOK layer for the model benchmark: login a tenant, validate a model's
// credentials via Kodus's own /test-byok probe, and set the org's BYOK_CONFIG
// so reviews actually run on that model.
import { http } from "../lib/http.js";
import type { BenchModel } from "./models.js";

export interface Session {
    apiBaseUrl: string;
    accessToken: string;
}

export async function login(
    apiBaseUrl: string,
    creds: { email: string; password: string },
): Promise<Session> {
    const resp = await http<{ data?: { accessToken?: string } }>(
        `${apiBaseUrl}/auth/login`,
        {
            method: "POST",
            body: { email: creds.email, password: creds.password },
            timeoutMs: 25_000,
        },
    );
    const token = resp.body?.data?.accessToken;
    if (!token) {
        throw new Error(
            `login failed for ${creds.email}: HTTP ${resp.status} ${resp.raw.slice(0, 200)}`,
        );
    }
    return { apiBaseUrl, accessToken: token };
}

function byokBody(model: BenchModel) {
    return {
        provider: model.provider,
        apiKey: model.apiKey,
        model: model.id,
        ...(model.baseURL ? { baseURL: model.baseURL } : {}),
        // Pin the model's required temperature from the catalog defaults. Some
        // models reject the engine's per-prompt temperature outright — e.g.
        // kimi-k2.7-code: "invalid temperature: only 1 is allowed for this
        // model" — which fails EVERY LLM call -> 0 findings -> a bogus F1.
        // byokPromptRunner forwards byokConfig.main.temperature to the LLM, so
        // pinning it here makes the review actually run for that model.
        ...((model.defaults as { temperature?: number } | undefined)?.temperature !== undefined
            ? { temperature: (model.defaults as { temperature?: number }).temperature }
            : {}),
    };
}

export interface TestByokResult {
    ok: boolean;
    code?: string;
    latencyMs?: number;
    message?: string;
}

/**
 * Probe the provider with this model's exact config (Kodus's own validation —
 * cheap list-models/identity call, no inference). Fails fast on a bad
 * key/model/baseURL so a misconfig never masquerades as "0 findings".
 */
export async function testByok(
    s: Session,
    model: BenchModel,
): Promise<TestByokResult> {
    if (!model.apiKey) {
        return { ok: false, code: "no_key", message: `${model.keyEnv} not set` };
    }
    const resp = await http<{ data?: TestByokResult }>(
        `${s.apiBaseUrl}/organization-parameters/test-byok`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${s.accessToken}` },
            body: byokBody(model),
            timeoutMs: 40_000,
        },
    );
    return (
        resp.body?.data ?? {
            ok: false,
            code: "http_" + resp.status,
            message: resp.raw.slice(0, 200),
        }
    );
}

/**
 * Set the org's main BYOK slot to this model so the review pipeline uses it.
 * (BYOK_CONFIG org-param; encrypted server-side.)
 */
export async function setByokConfig(
    s: Session,
    model: BenchModel,
): Promise<void> {
    const resp = await http(
        `${s.apiBaseUrl}/organization-parameters/create-or-update`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${s.accessToken}` },
            body: {
                key: "byok_config",
                configValue: { main: byokBody(model), fallback: null },
            },
            timeoutMs: 25_000,
        },
    );
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
            `setByokConfig(${model.slug}) failed: HTTP ${resp.status} ${resp.raw.slice(0, 200)}`,
        );
    }
}
