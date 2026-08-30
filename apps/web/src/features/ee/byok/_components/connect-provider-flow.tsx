"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    listByokProviders,
    type ByokProviderDescriptor,
} from "@services/organizationParameters/fetch";
import { ArrowLeftIcon, CheckCircle2Icon, LinkIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { PROVIDER_LABELS } from "../_data/provider-labels";
import { ProviderLogo } from "./provider-logo";

type ProviderChoice = {
    id: string;
    label: string;
    /** Registry signal: the provider can enumerate its models (listable
     *  endpoint) vs. a custom endpoint that must be typed manually. */
    autoListModels: boolean;
};

/** Fold to an alphanumeric key so `open_router` and `openrouter` collapse to one
 *  entry (id variants that name the same provider). */
const normalizeId = (id: string): string =>
    id.replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * The connectable provider list, driven by the backend ProviderModule REGISTRY
 * (the single source of truth). Each module is flattened to [id, ...aliases] so
 * every connectable id surfaces — including providers reached through a custom
 * endpoint (amazon_bedrock, google_vertex, anthropic_compatible, …).
 * `open_router`/`openrouter`-style duplicates collapse via normalizeId so a
 * provider never shows twice.
 */
export const registryProviders = (
    registry: ByokProviderDescriptor[],
): ProviderChoice[] => {
    const seen = new Set<string>();
    const out: ProviderChoice[] = [];

    for (const module of registry) {
        for (const id of [module.id, ...(module.aliases ?? [])]) {
            const key = normalizeId(id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                id,
                label: PROVIDER_LABELS[id] ?? module.label ?? id,
                // The descriptor's flag is for the canonical id; the `*_compatible`
                // aliases are custom endpoints (not auto-listable).
                autoListModels:
                    id === module.id ? module.autoListModels : false,
            });
        }
    }
    return out;
};

/** "Custom" providers are the ones you must point at an endpoint (`*_compatible`)
 *  or where you run an arbitrary model on a cloud you configure (Vertex, Bedrock,
 *  Azure). Everything ELSE is a first-class provider you connect with just a key —
 *  even when it has no curated models yet (it shows Browse models). */
const CUSTOM_PROVIDER_IDS = new Set([
    "google_vertex",
    "amazon_bedrock",
    "azure",
]);
const isCustomProvider = (id: string): boolean =>
    id.endsWith("_compatible") || CUSTOM_PROVIDER_IDS.has(id);

/** One provider tile in the grid. A provider with curated models opens the
 *  in-place model list; the rest go straight to the manual form pre-scoped to the
 *  provider. */
function ProviderGridCard({
    provider,
    connected,
    connectedCount,
    onPick,
}: {
    provider: ProviderChoice;
    /** The org already has a stored (non-managed) key for this provider. */
    connected?: boolean;
    /** How many models the org has ACTUALLY connected on this provider (not the
     *  catalog size) — shown next to "Connected" as a fact, not a promise. */
    connectedCount?: number;
    onPick: (p: ProviderChoice) => void;
}) {
    // Not auto-listable ⇒ a custom endpoint the user must point at their own
    // deployment (base URL first), vs. a listable provider.
    const needsEndpoint = !provider.autoListModels;
    return (
        <button
            type="button"
            onClick={() => onPick(provider)}
            className="border-card-lv2 bg-card-lv2 hover:border-primary-light/60 hover:bg-card-lv3 flex min-h-[4.25rem] items-center gap-3 rounded-lg border p-3 text-left transition-colors">
            <ProviderLogo
                provider={provider.id}
                label={provider.label}
                className="size-8 shrink-0"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-text-primary line-clamp-2 text-sm leading-tight font-semibold">
                    {provider.label}
                </span>
                {/* Catalog COUNT stays dropped — there's no per-provider model
                    list to preview (you go straight to the Add-a-model form), so a
                    catalog count reads as a promise the flow no longer makes. But
                    once a key is stored we show how many models are ACTUALLY
                    connected next to "Connected" (a fact); otherwise only the
                    "custom endpoint" hint stays. */}
                {connected ? (
                    <span className="text-success flex items-center gap-1 text-xs">
                        <CheckCircle2Icon size={11} className="shrink-0" />
                        Connected
                        {connectedCount && connectedCount > 0 ? (
                            <span className="text-text-tertiary">
                                · {connectedCount}{" "}
                                {connectedCount === 1 ? "model" : "models"}
                            </span>
                        ) : null}
                    </span>
                ) : (
                    needsEndpoint && (
                        <span className="text-text-tertiary flex items-center gap-1 text-xs">
                            <LinkIcon size={10} className="shrink-0" />
                            Custom endpoint
                        </span>
                    )
                )}
            </span>
        </button>
    );
}

/**
 * The shared PROVIDER-FIRST connect flow: pick a provider → get routed to that
 * provider's single Add-a-model form (`/byok/manual`), where the key is pasted
 * and the model chosen. Selection/navigation UI only — persistence lives on the
 * manual form.
 *
 * - No `lockedProvider`: show the provider grid first (used by "Add another
 *   provider" and, with a hero/footer, the first-run empty state).
 * - `lockedProvider` set: SKIP the grid and open that provider's form directly
 *   ("Add a model to {Provider}"), reusing the stored key via
 *   `existingKeyByProvider` so the form never re-asks for it.
 *
 * `hero`/`footer` are optional slots rendered around the provider grid so the
 * first-run card can keep its 🐶 hero + copy and the docs affordance while
 * sharing the exact same grid + navigation.
 */
export function ConnectProviderFlow({
    existingKeyByProvider = {},
    connectedModelCountByProvider = {},
    lockedProvider,
    onCancel,
    hero,
    footer,
}: {
    existingKeyByProvider?: Partial<Record<string, string>>;
    /** Provider id → number of models the org has connected on it, so a
     *  connected card can read "Connected · N models". */
    connectedModelCountByProvider?: Partial<Record<string, number>>;
    lockedProvider?: string;
    onCancel?: () => void;
    hero?: React.ReactNode;
    footer?: React.ReactNode;
}) {
    const router = useRouter();
    // Registry-driven provider list, fetched client-side with a graceful
    // fallback to the curated-derived list so the picker is never empty while
    // loading or if the fetch fails.
    const [registry, setRegistry] = useState<ByokProviderDescriptor[] | null>(
        null,
    );
    useEffect(() => {
        let alive = true;
        listByokProviders()
            .then((r) => {
                if (alive) setRegistry(r);
            })
            .catch(() => {
                if (alive) setRegistry([]);
            });
        return () => {
            alive = false;
        };
    }, []);

    // Provider list is purely registry-driven. `null` while the fetch is in
    // flight; the empty-state below only shows once it has resolved to a list.
    const providers = registry ? registryProviders(registry) : [];
    // Every provider now opens the SAME single Add-a-model form (the /manual
    // form) — there is no separate model-cards screen. A locked provider (the
    // "Add a model to {Provider}" entry) skips the grid and goes straight to
    // that provider's form too.
    useEffect(() => {
        if (lockedProvider) {
            router.replace(
                `/byok/manual?provider=${encodeURIComponent(lockedProvider)}`,
            );
        }
    }, [lockedProvider, router]);
    if (lockedProvider) return null;

    // Defensive: no connectable providers (registry loaded but empty).
    if (registry !== null && providers.length === 0) {
        return (
            <Card color="lv1">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-text-secondary text-sm text-balance">
                        No providers available. Use “Configure manually” to add
                        a model.
                    </p>
                    {onCancel && (
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                </CardContent>
            </Card>
        );
    }

    // Provider-first grid, split into Providers (everything you connect with a
    // key — curated or Browse) and Custom (bring-your-own endpoint / arbitrary
    // model). A provider with curated models opens its in-place list; the rest go
    // to the manual form. Model choice PER TASK is the Routing tab's job.
    // Every provider opens the SAME single Add-a-model form — no separate
    // model-cards screen. The form lists the provider's models when it can, or
    // takes a typed model id (driven by the registry per provider).
    const onPickProvider = (p: ProviderChoice) =>
        router.push(`/byok/manual?provider=${encodeURIComponent(p.id)}`);
    const mainProviders = providers.filter((p) => !isCustomProvider(p.id));
    const customProviders = providers.filter((p) => isCustomProvider(p.id));
    // Providers the org already connected (a stored non-managed key), normalized
    // so `open_router`/`openrouter`-style id variants match the grid's ids.
    const connectedIds = new Set(
        Object.keys(existingKeyByProvider).map(normalizeId),
    );
    const isConnected = (p: ProviderChoice) =>
        connectedIds.has(normalizeId(p.id));
    // Connected-model counts, normalized so id variants (open_router/openrouter)
    // resolve to the same grid card.
    const connectedCountByNorm = new Map<string, number>();
    for (const [prov, count] of Object.entries(connectedModelCountByProvider)) {
        if (typeof count === "number")
            connectedCountByNorm.set(normalizeId(prov), count);
    }
    const connectedCountOf = (p: ProviderChoice) =>
        connectedCountByNorm.get(normalizeId(p.id));

    return (
        <Card
            color="lv1"
            className={hero ? "ring-primary-light/30 ring-1" : undefined}>
            <CardContent
                className={cn(
                    "flex flex-col items-center gap-5",
                    hero ? "px-6 py-10 text-center" : "p-5",
                )}>
                {/* Breadcrumb back — the grid is reached from "Add another
                    provider"; the top-left arrow returns to the connected list
                    (matches the manual form's back affordance). Hidden on the
                    first-run hero, which has no list to go back to. */}
                {onCancel && !hero && (
                    <div className="flex w-full">
                        <Button
                            type="button"
                            size="icon-xs"
                            variant="cancel"
                            aria-label="Back"
                            onClick={onCancel}>
                            <ArrowLeftIcon />
                        </Button>
                    </div>
                )}
                {hero}

                <div className="flex w-full flex-col gap-6 text-left">
                    {mainProviders.length > 0 && (
                        <div className="flex flex-col gap-2.5">
                            <p className="text-text-tertiary text-xs font-semibold tracking-wide uppercase">
                                Providers
                            </p>
                            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                {mainProviders.map((p) => (
                                    <ProviderGridCard
                                        key={p.id}
                                        provider={p}
                                        connected={isConnected(p)}
                                        connectedCount={connectedCountOf(p)}
                                        onPick={onPickProvider}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {customProviders.length > 0 && (
                        <div className="flex flex-col gap-2.5">
                            <p className="text-text-tertiary text-xs font-semibold tracking-wide uppercase">
                                Custom
                            </p>
                            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                {customProviders.map((p) => (
                                    <ProviderGridCard
                                        key={p.id}
                                        provider={p}
                                        connected={isConnected(p)}
                                        connectedCount={connectedCountOf(p)}
                                        onPick={onPickProvider}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {(footer || onCancel) && (
                    <div className="flex flex-wrap items-center justify-center gap-4">
                        {footer}
                        {onCancel && (
                            <Button
                                type="button"
                                size="sm"
                                variant="cancel"
                                onClick={onCancel}>
                                Cancel
                            </Button>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
