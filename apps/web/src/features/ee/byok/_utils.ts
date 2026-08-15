import { UserRole } from "@enums";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import {
    Action,
    ResourceType,
    type PermissionsMap,
} from "@services/permissions/types";
import { hasPermission } from "src/core/utils/permission-map";

import type { OrganizationLicense } from "../subscription/_services/billing/types";
import type {
    BYOKConfig,
    BYOKCredential,
    BYOKModelConfig,
    LlmTask,
} from "./_types";

/**
 * The single source of truth for how the routing tasks are labeled in the UI.
 * Both the model row's "USED IN" chips and the routing tab's per-task override
 * grid render these, so the labels must never drift apart.
 */
export const TASK_LABELS: Record<LlmTask, string> = {
    codeReview: "Code Review",
    kodyRulesReview: "Kody Rules (review)",
    ruleGeneration: "Kody Rules (generation)",
    businessValidation: "Business Rules",
    prSummary: "PR Summary",
    conversation: "Chat",
};

/**
 * Plain-language, one-line purpose + trigger for each task, so an admin can
 * decide which model a task deserves WITHOUT already knowing Kodus's internal
 * task ontology. Shown under each task name in the routing UI. Keep them concrete
 * (what it does + when it runs + a volume hint where useful).
 */
export const TASK_DESCRIPTIONS: Record<LlmTask, string> = {
    codeReview:
        "Reviews every pull request and posts inline comments. Runs on each PR — highest volume.",
    kodyRulesReview:
        "Checks your custom rules against the changes during a review.",
    ruleGeneration: "Drafts new custom rules from your codebase, on demand.",
    businessValidation:
        "Validates a diff against your task's acceptance criteria.",
    prSummary: "Writes the summary at the top of each pull request.",
    conversation: "Powers the Kody chat assistant in the dashboard and IDE.",
};

/** Resolve a model id to its human label within a pool, falling back to the raw
 *  id then an em-dash. Shared by the routing tab and the per-task grid so the
 *  same lookup isn't written twice. */
export const modelLabelFor = (
    models: { id: string; label: string }[],
    id?: string,
): string => models.find((m) => m.id === id)?.label ?? id ?? "—";

/** Narrow an unknown blob to the v2 shape by its `version` discriminant. */
const isByokConfig = (
    config: BYOKConfig | null | undefined,
): config is BYOKConfig =>
    !!config &&
    typeof config === "object" &&
    (config as { version?: unknown }).version === 2;

/**
 * Group the v2 config's models by NON-managed credential. Returns one group per
 * real (BYOK) credential — `{ credential, models }` where `models` are the
 * config.models[] whose `credentialId` matches. Managed credentials (env
 * defaults) produce NO group and their models are excluded (RFC §4.5 /
 * UI-SPEC "Managed credential: never rendered"). A null/undefined/non-v2 blob
 * yields []. An absent routing block is tolerated.
 */
export const groupModelsByProvider = (
    config: BYOKConfig | null | undefined,
): { credential: BYOKCredential; models: BYOKModelConfig[] }[] => {
    if (!isByokConfig(config)) return [];
    // Bucket models by credentialId ONCE (O(n)) so the per-credential lookup
    // below is O(1) instead of a nested filter (O(credentials × models)).
    const modelsByCredential = new Map<string, BYOKModelConfig[]>();
    for (const model of config.models ?? []) {
        const bucket = modelsByCredential.get(model.credentialId);
        if (bucket) bucket.push(model);
        else modelsByCredential.set(model.credentialId, [model]);
    }
    return config.credentials
        .filter((c) => !c.managed)
        .map((credential) => ({
            credential,
            models: modelsByCredential.get(credential.id) ?? [],
        }));
};

/**
 * First-run check: true when the org has ≥1 NON-managed credential carrying at
 * least one model. The v2-native replacement for the legacy
 * `Boolean(byokConfig?.main)` presence check. False for null/undefined, a
 * non-v2 blob, a managed-only config, or a non-managed credential with no model.
 */
export const hasVisibleModels = (
    config: BYOKConfig | null | undefined,
): boolean =>
    groupModelsByProvider(config).some((group) => group.models.length > 0);

export const isBYOKSubscriptionPlan = (license: OrganizationLicense) => {
    if (
        license.subscriptionStatus === "self-hosted" ||
        license.subscriptionStatus === "licensed-self-hosted"
    ) {
        return true;
    }
    // Trial orgs don't carry a planType (they're exploring), but they
    // should still see the BYOK setup path — previously we required
    // "active", which blocked trial users from configuring their own
    // key during the trial. Canceled / expired / payment_failed /
    // inactive stay excluded.
    if (license.subscriptionStatus === "trial") {
        return true;
    }
    if (license.subscriptionStatus !== "active") {
        return false;
    }
    return license.planType.includes("byok");
};

export const isEnterprisePlan = (license: OrganizationLicense): boolean => {
    // Mirror of `isEnterpriseTierAllowed` in
    // `libs/ee/license/tier/enterprise-tier-policy.ts` — keep aligned.
    // CE self-hosted (no key) is modeled here as
    // `{ valid: true, subscriptionStatus: "self-hosted" }` and falls
    // into the `default` branch.
    if (!license.valid) return false;

    switch (license.subscriptionStatus) {
        case "active":
        case "licensed-self-hosted": {
            const plan = license.planType ?? "";
            return plan.startsWith("enterprise_") || plan === "enterprise";
        }
        case "trial":
            return true;
        default:
            return false;
    }
};

/**
 * Mirror of `isTeamsOrEnterpriseTierAllowed` in
 * `libs/ee/license/tier/teams-or-enterprise-tier-policy.ts` — keep aligned.
 *
 * Used by paid-team features such as linked repositories (cross-repo
 * context) and cockpit analytics.
 */
export const isTeamsOrEnterprisePlan = (
    license: OrganizationLicense,
): boolean => {
    if (!license.valid) return false;
    const plan = license.planType ?? "";
    const isTeams = plan.startsWith("teams_");
    const isEnterprise =
        plan.startsWith("enterprise_") || plan === "enterprise";

    switch (license.subscriptionStatus) {
        case "active":
            return isTeams || isEnterprise;
        case "licensed-self-hosted":
            return isEnterprise;
        case "trial":
            return true;
        default:
            return false;
    }
};

export const shouldShowBYOKMissingKeyTopbar = (params: {
    license: OrganizationLicense | null;
    llmConfigStatus: LLMConfigStatus | null | undefined;
    permissions: PermissionsMap;
    organizationId: string;
    role?: UserRole;
}) => {
    const { license, llmConfigStatus, permissions, organizationId, role } =
        params;

    if (!license || !isBYOKSubscriptionPlan(license)) {
        return false;
    }

    // Either source (DB BYOK or self-hosted `.env`) is enough to run reviews.
    // Only nag when nothing is configured at all.
    if (llmConfigStatus && llmConfigStatus.source !== "none") {
        return false;
    }

    // Trial orgs can configure BYOK if they want, but we don't nag them
    // with the persistent "missing key" topbar — the alert is only for
    // paying plans where BYOK is expected.
    if (license.subscriptionStatus === "trial") {
        return false;
    }

    if (role === UserRole.OWNER) {
        return true;
    }

    return hasPermission({
        permissions,
        organizationId,
        action: Action.Update,
        resource: ResourceType.OrganizationSettings,
    });
};

/**
 * Mirror of `supportsSamplingParams` in `libs/llm/anthropic-model-traits.ts`
 * — keep aligned.
 *
 * Anthropic removed temperature / top_p / top_k from Claude 4.7 onward:
 * sending one is a 400 that fails the whole request. The backend already
 * withholds the value, so this only decides whether we show a field that
 * could not take effect. An unrecognized Claude is treated as new (same bias
 * as the backend) — a model we can't place is far more likely to be newer
 * than one of the handful of legacy ids.
 */
export const anthropicRejectsTemperature = (
    provider?: string,
    model?: string,
): boolean => {
    if (provider !== "anthropic") return false;
    if (!model?.trim()) return true;

    let name = model.trim().toLowerCase();
    const colon = name.indexOf(":");
    if (colon > -1) name = name.slice(colon + 1);
    if (name.startsWith("anthropic.")) name = name.slice("anthropic.".length);
    name = name.split("@")[0].replace(/-\d{8}$/, "");

    // Claude 2.x / 3.x, and 4 through 4.5, still accept sampling params — as
    // does 4.6, the last generation before they were removed.
    const acceptsSamplingParams =
        /^claude-[23](\b|[-.])/.test(name) ||
        /^claude-(opus|sonnet|haiku)-4(-[0-6])?$/.test(name);

    return !acceptsSamplingParams;
};

/**
 * Obfuscate an API key for display so shoulder-surfing and screen-sharing
 * can't leak the secret. Keeps a short prefix + suffix so the user can
 * still recognize which key is stored.
 */
export const maskKey = (key?: string): string => {
    if (!key) return "";
    if (key.length <= 8) return "•••• ••••";
    return `${key.slice(0, 4)}•••••${key.slice(-4)}`;
};

/**
 * Provider-tinted avatar classes (a subtle bg tint + a readable foreground),
 * keyed by BYOKProvider. Shared by the model row and the provider group header
 * so the same provider reads with the same colour everywhere on the screen.
 */
export const PROVIDER_AVATAR: Record<string, string> = {
    anthropic: "bg-pink-500/15 text-pink-300",
    anthropic_compatible: "bg-pink-500/15 text-pink-300",
    openai: "bg-emerald-500/15 text-emerald-300",
    openai_compatible: "bg-amber-500/15 text-amber-300",
    moonshot: "bg-purple-500/15 text-purple-300",
    google_gemini: "bg-violet-500/15 text-violet-300",
    google_vertex: "bg-violet-500/15 text-violet-300",
    azure: "bg-sky-500/15 text-sky-300",
};

/** Avatar tint for a provider, falling back to a neutral card tint. */
export const providerAvatarTint = (provider?: string): string =>
    (provider && PROVIDER_AVATAR[provider]) ?? "bg-card-lv2 text-text-secondary";

/** Single-letter glyph per provider for the avatar badge. */
const PROVIDER_LETTER: Record<string, string> = {
    anthropic: "A",
    anthropic_compatible: "A",
    openai: "O",
    openai_compatible: "O",
    moonshot: "K",
    google_gemini: "G",
    google_vertex: "G",
    azure: "Z",
};

export const providerLetter = (provider?: string): string =>
    (provider && PROVIDER_LETTER[provider]) ??
    provider?.[0]?.toUpperCase() ??
    "•";

/**
 * Best-effort provider inference from a bare model NAME — used only where the
 * provider isn't carried alongside the model (e.g. the read-only per-repository
 * mirror, whose entries store a model string but not its provider). Falls back
 * to undefined (neutral avatar) when nothing matches.
 */
export const providerFromModel = (model?: string): string | undefined => {
    if (!model) return undefined;
    const m = model.toLowerCase();
    if (m.includes("claude")) return "anthropic";
    if (m.includes("gemini")) return "google_gemini";
    if (m.includes("kimi") || m.includes("moonshot")) return "moonshot";
    if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3"))
        return "openai";
    return undefined;
};
