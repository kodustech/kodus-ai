import { http } from "./http.js";
import type { KodusSession } from "./types.js";

// Shared Claude-on-Vertex BYOK helpers, used by every vertex-byok scenario
// (code-review, conversation, kody-issues). Keeps the /test-byok probe +
// byok_config write in one place so all three exercise the exact same wiring.

export interface VertexByokCfg {
    saJson: string;
    region: string;
    model: string;
}

/** Reads the Vertex BYOK config from env, or null when VERTEX_SA_JSON is
 *  absent (the scenario then ctx.assert-skips with a clear message). The SA
 *  JSON may be raw or base64 — the backend adapter accepts both. */
export function readVertexByokEnv(): VertexByokCfg | null {
    const saJson = process.env.VERTEX_SA_JSON;
    if (!saJson) return null;
    return {
        saJson,
        region: process.env.VERTEX_REGION || "global",
        // claude-sonnet-4-6 is the default; override with VERTEX_MODEL to a
        // model actually enabled in the project's Vertex AI Model Garden.
        model: process.env.VERTEX_MODEL || "claude-sonnet-4-6",
    };
}

/**
 * Point the org's main BYOK slot at a Claude model on Google Vertex. Probes
 * /test-byok first so a missing Model-Garden enablement or a bad service
 * account fails HERE with Google's actual reason — not later as a silent
 * "Kody never responded".
 */
export async function setVertexByok(
    apiBaseUrl: string,
    session: KodusSession,
    cfg: VertexByokCfg,
): Promise<void> {
    const main = {
        provider: "google_vertex",
        apiKey: cfg.saJson,
        model: cfg.model,
        vertexLocation: cfg.region,
    };
    const auth = { Authorization: `Bearer ${session.accessToken}` };

    const test = await http<{ data?: { ok?: boolean; message?: string } }>(
        `${apiBaseUrl}/organization-parameters/test-byok`,
        { method: "POST", headers: auth, body: main, timeoutMs: 40_000 },
    );
    if (!test.body?.data?.ok) {
        const reason = test.body?.data?.message ?? test.raw.slice(0, 300);
        throw new Error(
            `Vertex BYOK test-byok failed for ${cfg.model} @ ${cfg.region}: ${reason}`,
        );
    }

    const save = await http(
        `${apiBaseUrl}/organization-parameters/create-or-update`,
        {
            method: "POST",
            headers: auth,
            body: { key: "byok_config", configValue: { main, fallback: null } },
            timeoutMs: 25_000,
        },
    );
    if (save.status < 200 || save.status >= 300) {
        throw new Error(
            `setVertexByok save failed: HTTP ${save.status} ${save.raw.slice(0, 200)}`,
        );
    }
}
