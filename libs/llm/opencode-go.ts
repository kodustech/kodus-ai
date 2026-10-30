/**
 * OpenCode Go (`opencode.ai/zen/go`) started enforcing an `x-opencode-session`
 * header around 2026-09-06 — a request missing it now gets HTTP 400
 * ("Request is missing x-opencode-session and cannot be routed efficiently")
 * instead of being served, breaking every BYOK review configured against it
 * (issue #1880). Their docs ask for a header that is "stable" per conversation
 * for routing/prompt-cache locality, not a security token, so a deterministic
 * id derived from the resolved slot is enough — no session-tracking plumbing.
 *
 * A dependency-free leaf (mirrors structured-output-gate.ts / base-url-hygiene.ts)
 * so every place that can build a request AT this baseURL can import it without
 * a cycle: the openai module (chat completions / responses), the anthropic
 * module (OpenCode Go also exposes an Anthropic Messages-compatible endpoint),
 * and managed-slot.ts's self-hosted `openai_compat` INLINE exception, which
 * builds its client directly and never calls either provider module's `build()`.
 */
import { createHash, createHmac } from 'crypto';

/**
 * HOST-only check, no path restriction — matches `jcode`'s own fix for this
 * exact issue (github.com/1jehuang/jcode PR #1172, linked from OpenCode's own
 * "Validated Clients" table):
 *
 *   fn is_opencode_api_base(api_base: &str) -> bool {
 *       matches!(url.host_str(), Some(host) if host == "opencode.ai" || host.ends_with(".opencode.ai"))
 *   }
 *
 * Two things this codebase tried and rejected before landing here:
 *  1. A plain substring regex (`/opencode\.ai\/zen/i.test(baseURL)`) — also
 *     matches `https://notopencode.ai/zen/v1` and a corp gateway path like
 *     `https://gw.corp.example/opencode.ai/zen/v1`, attaching the header to
 *     an upstream that isn't OpenCode at all (a strict server could 400 on
 *     an unrecognized `x-*` header — the exact failure class this exists to
 *     avoid). Fixed by parsing the URL for real instead of scanning the
 *     whole string, same idiom base-url-hygiene.ts uses for the same reason.
 *  2. Requiring the path to start with `/zen` (or `/zen/go`) — reasoning
 *     from OpenCode's docs that the session-header requirement is scoped to
 *     a specific tier/path. Real production BYOK configs proved the `/go`
 *     version wrong (`libs/llm/testing/__fixtures__/byok-prod-shapes.json`
 *     has live orgs on bare `opencode.ai/zen/v1`, no `/go`), and jcode's own
 *     validated fix doesn't check the path at all — just the host. Matching
 *     on host alone is a strict superset of every real shape seen so far,
 *     and the same asymmetry as always applies: an extra header costs
 *     nothing (OpenCode's docs call it "recommended", never rejected); a
 *     missed one 400s a real customer's every review.
 */
export function isOpenCodeGoBaseUrl(baseURL?: string): boolean {
    if (!baseURL) return false;
    let parsed: URL;
    try {
        parsed = new URL(baseURL);
    } catch {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
}

/** The handful of `NormalizedModel` fields `openCodeSessionId` actually reads
 *  — narrowed so a caller with no full slot (managed-slot.ts's inline
 *  self-hosted branch has no `byokModelId`/`credentialId` at all) can still
 *  call it without fabricating one. */
export interface OpenCodeSessionInput {
    model: string;
    baseURL?: string;
    byokModelId?: string;
    credentialId?: string;
}

/**
 * Stable per BYOK model slot, falling back to the resolved CREDENTIAL's id
 * when the slot carries no `byokModelId`, then to a deployment-scoped HMAC
 * as the last resort for neither — a slot with NO BYOK config at all. Within
 * a provider module's own `build()`, that last tier is dead: every config-based
 * slot reaching it via byok-to-vercel.ts already carries a `credentialId`
 * (resolve-model-slot.ts can't build one without finding a credential first).
 * It IS reached, though — by `managed-slot.ts`'s self-hosted `openai_compat`
 * case, which builds its `createOpenAICompatible` INLINE and never calls a
 * provider module's `build()` at all; that is genuinely the one config shape
 * with no BYOK ids whatsoever, so this function is exported for it to call
 * directly.
 *
 * Three rejected-in-review attempts got here:
 *  1. A process-random salt: changes on every restart/pod rotation (not
 *     "stable"), AND identical for every org sharing the process and landing
 *     on this fallback — doesn't fix the collision it exists to prevent,
 *     since OpenCode Go's baseURL and model catalog are the same for
 *     everyone.
 *  2. Hashing the credential's own API KEY: fixed the collision (unique per
 *     org/deployment, persisted across restarts) but CodeQL flagged it as
 *     "password hash with insufficient computational effort" — its static
 *     taint analysis flags ANY `createHash()` fed by a value sourced from
 *     `apiKey`, full stop, regardless of the fact that the SAME key is
 *     already sent to OpenCode in cleartext as the request's own Bearer
 *     token (so the hash itself discloses nothing new to that recipient).
 *  3. Dropping the key from the last-resort tier entirely (falling straight
 *     to bare `model:baseURL`): reintroduced exactly the collision (1) was
 *     meant to fix, since every self-hosted install shares that same bare
 *     seed once it targets the same OpenCode Go model.
 *
 * The fix: keep secret material out of `createHash()` entirely, but still
 * use it — as the KEY of an HMAC, which is what a secret is FOR, rather than
 * as hashed message content. `API_CRYPTO_KEY` (libs/common/utils/crypto.ts)
 * is already the one persisted, deployment-scoped secret every install needs
 * for BYOK apiKey encryption, so this reuses it instead of adding a new env
 * var — unique per self-hosted deployment, stable across restarts, and
 * outside the specific pattern CodeQL flags. REQUIRED, not `?? ''`: a silent
 * empty-string default would be the SAME weak key on every deployment that
 * happens to be missing it, i.e. attempt (3)'s collision again — fail loud
 * instead, matching crypto.ts's own fail-fast contract for this exact var.
 *
 * HASHED/HMAC'd rather than sent raw either way: OpenCode only needs an
 * opaque value that stays constant call-to-call, not our internal id, so
 * there is no reason to hand a third party a stable handle onto it.
 */
export function openCodeSessionId(cfg: OpenCodeSessionInput): string {
    const id = cfg.byokModelId || cfg.credentialId;
    if (id) {
        return createHash('sha256').update(id).digest('hex').slice(0, 32);
    }
    const hmacKey = process.env.API_CRYPTO_KEY;
    if (!hmacKey) {
        throw new Error(
            'API_CRYPTO_KEY is required to derive the OpenCode Go session id',
        );
    }
    return createHmac('sha256', hmacKey)
        .update(`${cfg.model}:${cfg.baseURL ?? ''}`)
        .digest('hex')
        .slice(0, 32);
}
