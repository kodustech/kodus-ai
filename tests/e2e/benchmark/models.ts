// Tier-0 model list for the per-model code-review benchmark.
//
// SOURCE OF TRUTH is the BYOK tool's own catalog
// (apps/web/src/features/ee/byok/_data/curated-models.json, tier="recommended").
// We read it directly so the benchmark stays in sync with what the product
// actually offers — no hand-maintained model list to drift.
//
// Each model maps to a BYOK config: { provider, model, apiKey, baseURL }.
// The apiKey comes from a per-provider env var (BYOK_*_API_KEY); see
// resolveKeyEnv. baseURL comes from the catalog's defaults for
// openai_compatible providers (Moonshot/Kimi, Z.ai/GLM).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG = join(
    process.cwd(),
    "..",
    "..",
    "apps",
    "web",
    "src",
    "features",
    "ee",
    "byok",
    "_data",
    "curated-models.json",
);

export interface CuratedModelRaw {
    id: string;
    displayName: string;
    provider: string; // anthropic | openai | google_gemini | openai_compatible
    providerDisplayName?: string;
    tier: string;
    benchmarkScore?: number;
    defaults?: {
        baseURL?: string;
        temperature?: number;
        maxOutputTokens?: number;
        reasoningEffort?: string;
    };
}

export interface BenchModel {
    /** Stable slug for repos/runs/scorecard, e.g. "sonnet-4-6". */
    slug: string;
    id: string; // model id sent to the provider, e.g. "claude-sonnet-4-6"
    displayName: string;
    provider: string;
    baseURL?: string;
    keyEnv: string;
    apiKey?: string; // resolved from process.env[keyEnv] (undefined if unset)
    defaults: NonNullable<CuratedModelRaw["defaults"]>;
}

// Which env var holds the key for a given catalog model. provider alone is
// ambiguous for openai_compatible (Kimi and GLM share it), so disambiguate by
// baseURL host.
function resolveKeyEnv(provider: string, baseURL?: string): string {
    switch (provider) {
        case "anthropic":
            return "BYOK_ANTHROPIC_API_KEY";
        case "openai":
            return "BYOK_OPENAI_API_KEY";
        case "google_gemini":
            return "BYOK_GOOGLE_API_KEY";
        case "openai_compatible": {
            const u = baseURL ?? "";
            // Match by parsed HOSTNAME (exact or subdomain), never substring —
            // a substring check (u.includes("kimi.com")) would also match a
            // hostile host like "kimi.com.evil.com" or ".../kimi.com" (CodeQL:
            // incomplete URL substring sanitization).
            let host: string;
            try {
                host = new URL(u).hostname.toLowerCase();
            } catch {
                throw new Error(
                    `openai_compatible model with invalid baseURL "${u}" — add a key mapping in resolveKeyEnv`,
                );
            }
            const hostIn = (...domains: string[]) =>
                domains.some((d) => host === d || host.endsWith(`.${d}`));
            if (hostIn("moonshot.ai", "moonshot.cn", "kimi.com")) {
                return "BYOK_MOONSHOT_API_KEY";
            }
            if (hostIn("z.ai", "bigmodel.cn")) {
                return "BYOK_ZHIPU_API_KEY";
            }
            throw new Error(
                `openai_compatible model with unrecognized baseURL "${u}" (host ${host}) — add a key mapping in resolveKeyEnv`,
            );
        }
        default:
            throw new Error(`Unknown BYOK provider "${provider}"`);
    }
}

// A filesystem/url-safe slug from the model id (drop the leading vendor prefix
// noise; keep it short + unique). e.g. claude-sonnet-4-6 -> sonnet-4-6,
// gemini-3.1-pro-preview-customtools -> gemini-3-1-pro-customtools.
export function modelSlug(id: string): string {
    return id
        .replace(/^claude-/, "")
        .replace(/-preview/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/-+$/g, "")
        .toLowerCase();
}

/** Load the tier-0 (recommended) models from the BYOK catalog. */
export function loadTier0Models(): BenchModel[] {
    const raw = JSON.parse(readFileSync(CATALOG, "utf8")) as {
        models: CuratedModelRaw[];
    };
    const recommended = raw.models.filter((m) => m.tier === "recommended");
    if (recommended.length === 0) {
        throw new Error(
            `No tier="recommended" models in the BYOK catalog at ${CATALOG}`,
        );
    }
    return recommended.map((m) => {
        const baseURL = m.defaults?.baseURL;
        const keyEnv = resolveKeyEnv(m.provider, baseURL);
        return {
            slug: modelSlug(m.id),
            id: m.id,
            displayName: m.displayName,
            provider: m.provider,
            baseURL,
            keyEnv,
            apiKey: process.env[keyEnv] || undefined,
            defaults: m.defaults ?? {},
        };
    });
}
