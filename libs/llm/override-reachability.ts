/**
 * "Did the override the user pasted actually reach the request?"
 *
 * WHY THIS EXISTS
 * The Custom reasoning override is a free-text JSON box. Save time already
 * rejects JSON that does not PARSE. The other half is JSON that parses fine and
 * is then dropped between us and the wire — every AI SDK adapter validates its
 * `providerOptions` against a schema that STRIPS unknown keys, silently, with no
 * warning and no error. From the user's side that is indistinguishable from a
 * provider that ignored them.
 *
 * It is not hypothetical. A live org runs Claude with
 *   { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } }
 * which is the shape Anthropic's own API docs show. `@ai-sdk/anthropic` declares
 * that field as `effort` and renders `output_config` itself, so the pasted half
 * is stripped: they get adaptive thinking at the default effort and have never
 * been told.
 *
 * WHY NOT A PER-PROVIDER KEY LIST
 * The obvious fix is for each module to declare the keys its adapter accepts.
 * That is a second copy of a schema the SDK already owns, in twelve files, and
 * every one of them is a fact that can rot without anything noticing — the exact
 * shape of bug this file exists to catch. The SDK will not hand us the schema
 * either (only the TYPE is exported), so the copy could not even be checked.
 *
 * So the question is answered from EVIDENCE instead: `include: { requestBody:
 * true }` gives back the body the adapter actually built, and a key that
 * survived left its values in it.
 *
 * WHY VALUES AND NOT KEY NAMES
 * Because renaming is normal and correct: the user writes `effort` and the wire
 * carries `output_config.effort`; `thinkingBudget` becomes
 * `generationConfig.thinkingConfig.thinkingBudget`. Matching names would flag
 * every faithful translation. Values survive renaming — `"high"` is still
 * `"high"` — so a key is "reached" when at least one of its own leaf values
 * appears somewhere in the body.
 *
 * The bias is deliberate: a value that collides with an unrelated one in the
 * body reads as reached, so this UNDER-reports. A false alarm would teach people
 * to ignore the warning, which costs more than a miss.
 */

/** Every scalar anywhere in a value, as strings — the comparable surface. */
function collectScalars(node: unknown, out: Set<string>): void {
    if (node === null || node === undefined) return;
    if (typeof node === 'object') {
        for (const v of Object.values(node as Record<string, unknown>)) {
            collectScalars(v, out);
        }
        return;
    }
    out.add(String(node));
}

/** The request body as an object, whichever way the adapter returned it —
 *  `@ai-sdk/anthropic` and the Google adapters hand back a parsed object, the
 *  OpenAI-compatible one hands back the serialized string. */
function bodyScalars(requestBody: unknown): Set<string> {
    const out = new Set<string>();
    if (typeof requestBody === 'string') {
        try {
            collectScalars(JSON.parse(requestBody), out);
        } catch {
            // Not JSON — compare against the raw text rather than give up, so a
            // form-encoded or plain body still answers the question.
            out.add(requestBody);
        }
        return out;
    }
    collectScalars(requestBody, out);
    return out;
}

export interface UnreachedKey {
    /** The `providerOptions` namespace the key was sent under. */
    namespace: string;
    /** The top-level key inside that namespace, as the user wrote it. */
    key: string;
}

/**
 * Keys present in the RESOLVED `providerOptions` whose values left no trace in
 * the request body.
 *
 * Call it only for a slot that carries a `reasoningConfigOverride`: in that case
 * `buildProviderOptions` returns the user's override (plus OpenRouter routing)
 * and nothing else, so every key here is one the user typed.
 *
 * A key with no scalar values of its own (`{}`, `[]`) is skipped — there is
 * nothing that could have left a trace, so no evidence either way.
 */
export function unreachedOverrideKeys(
    providerOptions: Record<string, unknown> | undefined,
    requestBody: unknown,
): UnreachedKey[] {
    if (!providerOptions || typeof providerOptions !== 'object') return [];
    if (requestBody === undefined || requestBody === null) return [];

    const inBody = bodyScalars(requestBody);
    if (inBody.size === 0) return [];

    const unreached: UnreachedKey[] = [];
    for (const [namespace, options] of Object.entries(providerOptions)) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            continue;
        }
        for (const [key, value] of Object.entries(
            options as Record<string, unknown>,
        )) {
            const values = new Set<string>();
            collectScalars(value, values);
            if (values.size === 0) continue;
            let reached = false;
            for (const v of values) {
                if (inBody.has(v)) {
                    reached = true;
                    break;
                }
            }
            if (!reached) unreached.push({ namespace, key });
        }
    }
    return unreached;
}

/** One sentence per dropped key, for the connect form. Says what was ignored and
 *  where to look, and does NOT guess the right spelling — the module's own
 *  example is what teaches that, and it is already shown next to the box. */
export function describeUnreachedKeys(
    keys: UnreachedKey[] | undefined,
): string | undefined {
    // Tolerates a missing list on purpose: this runs on the SUCCESS path of the
    // connection test, and an advisory that throws would turn a working
    // credential into a reported failure — a worse bug than the one it reports.
    if (!keys?.length) return undefined;
    const names = keys.map((k) => `"${k.key}"`).join(', ');
    return (
        `The connection works, but ${keys.length === 1 ? 'this key in' : 'these keys in'} your custom ` +
        `reasoning override never reached the provider: ${names}. ` +
        `They are not options this provider's adapter accepts, so they were ignored — ` +
        `compare with the example shown under the box.`
    );
}
