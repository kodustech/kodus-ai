"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    listByokProviders,
    type ByokProviderDescriptor,
} from "@services/organizationParameters/fetch";
import { ArrowLeftIcon, LinkIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { useCatalog } from "../_data/catalog-context";
import type { CuratedModel } from "../_data/curated-models.types";
import type { BYOKConnectInput } from "../_types";
import { CuratedConnectPanel } from "./catalog/connect-panel";
import {
    CuratedModelCard,
    ModelCardLegend,
    PROVIDER_LABELS,
} from "./catalog/model-card";
import { ProviderLogo } from "./provider-logo";

type ProviderChoice = {
    id: string;
    label: string;
    modelCount: number;
    /** Registry signal: the provider can enumerate its models (static catalog or
     *  listable endpoint) vs. a custom endpoint that must be typed manually. */
    autoListModels: boolean;
};

/**
 * The distinct providers in the curated catalog, in first-appearance order —
 * the provider-first entry point. Each carries a human label (the shared
 * PROVIDER_LABELS, falling back to the catalog's providerDisplayName) and how
 * many curated models it offers, so the picker can show "N models".
 *
 * Still exported: it is the GRACEFUL FALLBACK the registry-driven grid uses
 * while the backend list loads or if that fetch fails (never an empty picker).
 */
/**
 * The provider IDENTITY a curated model groups under: its BRAND (`providerKey`,
 * e.g. `moonshot` / `zai`) when set, else the TRANSPORT `provider` (e.g.
 * `openai_compatible`). The picker groups AND filters by this, so a brand served
 * over a shared transport still gets its own card (Moonshot, Z.ai) instead of
 * being lumped under the generic "OpenAI-compatible" bucket. The stored config
 * still uses the transport `provider` + baseURL — this only affects the UI.
 */
const providerKeyOf = (m: CuratedModel): string => m.providerKey ?? m.provider;

export const catalogProviders = (
    catalog: CuratedModel[],
): ProviderChoice[] => {
    const byId = new Map<string, ProviderChoice>();
    for (const m of catalog) {
        const key = providerKeyOf(m);
        const existing = byId.get(key);
        if (existing) {
            existing.modelCount += 1;
            continue;
        }
        byId.set(key, {
            id: key,
            label: PROVIDER_LABELS[key] ?? m.providerDisplayName ?? key,
            modelCount: 1,
            // Curated providers always show a count, so this only matters as the
            // registry-fetch fallback — a curated provider is listable.
            autoListModels: true,
        });
    }
    return Array.from(byId.values());
};

/** How many curated models group under a given provider identity (0 for
 *  registry-only ones). Keyed by brand, matching the picker's grouping. */
const curatedModelCount = (
    catalog: CuratedModel[],
    providerId: string,
): number =>
    catalog.filter((m) => providerKeyOf(m) === providerId).length;

/** Fold to an alphanumeric key so `open_router` and `openrouter` collapse to one
 *  entry (the registry id and the curated id name the same provider). */
const normalizeId = (id: string): string =>
    id.replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * The connectable provider list, driven by the backend ProviderModule REGISTRY
 * (the single source of truth). Each module is flattened to [id, ...aliases] so
 * every connectable id surfaces — including providers with NO curated models
 * (amazon_bedrock, google_vertex, novita, anthropic_compatible, moonshot). The
 * curated providers keep their first-appearance order at the front; the extra
 * registry-only ids follow. `open_router`/`openrouter`-style duplicates collapse
 * via normalizeId so a curated provider never shows twice.
 */
export const registryProviders = (
    catalog: CuratedModel[],
    registry: ByokProviderDescriptor[],
): ProviderChoice[] => {
    // Curated-first: keep the exact existing ordering + counts up front.
    const curated = catalogProviders(catalog);
    const seen = new Set(curated.map((p) => normalizeId(p.id)));
    const out: ProviderChoice[] = [...curated];

    for (const module of registry) {
        for (const id of [module.id, ...(module.aliases ?? [])]) {
            const key = normalizeId(id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                id,
                label: PROVIDER_LABELS[id] ?? module.label ?? id,
                modelCount: curatedModelCount(catalog, id),
                // The descriptor's flag is for the canonical id; the `*_compatible`
                // aliases are custom endpoints (not auto-listable).
                autoListModels:
                    id === module.id ? module.autoListModels : false,
            });
        }
    }
    return out;
};

const providerLabelFor = (
    providerId: string,
    providers: ProviderChoice[],
): string =>
    PROVIDER_LABELS[providerId] ??
    providers.find((p) => p.id === providerId)?.label ??
    providerId;

/** One provider tile in the grid. Curated providers (≥1 curated model) open the
 *  in-place model list; the rest are custom/self-hosted and go straight to the
 *  manual form pre-scoped to the provider. */
function ProviderGridCard({
    provider,
    onPick,
}: {
    provider: ProviderChoice;
    onPick: (p: ProviderChoice) => void;
}) {
    // No curated models AND not auto-listable ⇒ a custom endpoint the user must
    // point at their own deployment (base URL first), vs. a listable catalog.
    const needsEndpoint = !provider.autoListModels && provider.modelCount === 0;
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
                <span className="text-text-tertiary flex items-center gap-1 text-xs tabular-nums">
                    {provider.modelCount > 0 ? (
                        `${provider.modelCount} ${provider.modelCount === 1 ? "model" : "models"}`
                    ) : needsEndpoint ? (
                        <>
                            <LinkIcon size={10} className="shrink-0" />
                            Custom endpoint
                        </>
                    ) : (
                        "Browse models"
                    )}
                </span>
            </span>
        </button>
    );
}

/**
 * The shared PROVIDER-FIRST connect flow: pick a provider → see ALL of that
 * provider's curated models (sorted by benchmark, not tier-limited) → paste the
 * key in the connect panel. Selection UI only — persistence is the caller's job
 * via `onSave` (which builds the v2 blob).
 *
 * - No `lockedProvider`: show the provider grid first (used by "Add another
 *   provider" and, with a hero/footer, the first-run empty state).
 * - `lockedProvider` set: SKIP the grid and open that provider's model list
 *   directly ("Add a model to {Provider}"), reusing the stored key via
 *   `existingKeyByProvider` so the connect panel never re-asks for it.
 *
 * `hero`/`footer` are optional slots rendered around the provider grid so the
 * first-run card can keep its 🐶 hero + copy and the "Browse all models" /
 * docs affordances while sharing the exact same grid + models + connect UI.
 */
export function ConnectProviderFlow({
    existingKeyByProvider = {},
    lockedProvider,
    onSave,
    onCancel,
    hero,
    footer,
}: {
    existingKeyByProvider?: Partial<Record<string, string>>;
    lockedProvider?: string;
    onSave: (cfg: BYOKConnectInput) => Promise<void>;
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

    const catalog = useCatalog();
    const providers =
        registry && registry.length > 0
            ? registryProviders(catalog, registry)
            : catalogProviders(catalog);
    const [pickedProvider, setPickedProvider] = useState<string | null>(
        lockedProvider ?? null,
    );
    const [selected, setSelected] = useState<CuratedModel | null>(null);

    // A specific model pick — its dedicated connect panel (key + test). When the
    // provider already has a stored key it is passed through so the panel offers
    // "leave blank to keep" instead of demanding the key again.
    if (selected) {
        return (
            <CuratedConnectPanel
                model={selected}
                existingKey={existingKeyByProvider[selected.provider]}
                onBack={() => setSelected(null)}
                onSave={onSave}
            />
        );
    }

    // A provider was chosen (via the grid) or locked in by the caller — pick
    // which of ITS models to enable next. All of the provider's catalog models,
    // sorted by benchmark; never the tier-recommended subset.
    if (pickedProvider) {
        const locked = !!lockedProvider;
        const label = providerLabelFor(pickedProvider, providers);
        const providerModels = catalog
            .filter((m) => providerKeyOf(m) === pickedProvider)
            .sort((a, b) => b.benchmarkScore - a.benchmarkScore);

        return (
            <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1">
                    {locked
                        ? onCancel && (
                              <Button
                                  type="button"
                                  size="xs"
                                  variant="cancel"
                                  leftIcon={<ArrowLeftIcon />}
                                  className="-ml-2 self-start"
                                  onClick={onCancel}>
                                  Back
                              </Button>
                          )
                        : (
                              <Button
                                  type="button"
                                  size="xs"
                                  variant="cancel"
                                  leftIcon={<ArrowLeftIcon />}
                                  className="-ml-2 self-start"
                                  onClick={() => setPickedProvider(null)}>
                                  All providers
                              </Button>
                          )}
                    <h3 className="text-text-primary text-lg font-semibold text-balance">
                        {locked ? `Add a model to ${label}` : `Connect ${label}`}
                    </h3>
                    <p className="text-text-secondary text-sm text-pretty">
                        {locked
                            ? `Pick a model to enable — your ${label} key is already stored.`
                            : `Pick a model to enable — you’ll paste your ${label} key next.`}
                    </p>
                </div>

                {providerModels.length > 0 ? (
                    <div className="flex flex-col gap-3">
                        {/* Score/legend omitted here — picking the best model per
                            task is the Routing tab's job; connect just enables a
                            provider's models. */}
                        <ModelCardLegend showScore={false} />
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {providerModels.map((model) => (
                                <CuratedModelCard
                                    key={model.id}
                                    model={model}
                                    showConnect
                                    showScore={false}
                                    onSelect={() => setSelected(model)}
                                />
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-start gap-3">
                        <p className="text-text-tertiary text-sm text-pretty">
                            {locked
                                ? `Pick or type a ${label} model on the next screen — your key is already stored.`
                                : `Set up ${label} on the next screen — add your key, then pick from its model list (or type a model ID).`}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            onClick={() =>
                                // Pre-scope the manual form to THIS provider (and
                                // reuse a stored key). The manual screen lists the
                                // provider's models when it can, or takes a typed
                                // model id — driven by the registry per provider.
                                router.push(
                                    `/organization/byok/manual?provider=${encodeURIComponent(pickedProvider)}`,
                                )
                            }>
                            Continue
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    // Defensive: an empty catalog can't drive a provider-first pick.
    if (providers.length === 0) {
        return (
            <Card color="lv1">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-text-secondary text-sm text-balance">
                        No providers available. Use “Configure manually” to add a
                        model.
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

    // Provider-first grid, split into two honest groups: curated brands you pick
    // a model from in place, and custom/self-hosted endpoints (Bedrock, Vertex,
    // Azure, Novita, *-compatible) that go to the manual form. Model choice PER
    // TASK is the Routing tab's job — the connect step only wires up providers.
    const onPickProvider = (p: ProviderChoice) =>
        p.modelCount > 0
            ? setPickedProvider(p.id)
            : router.push(
                  `/organization/byok/manual?provider=${encodeURIComponent(p.id)}`,
              );
    const curatedProviders = providers.filter((p) => p.modelCount > 0);
    const customProviders = providers.filter((p) => p.modelCount === 0);

    return (
        <Card
            color="lv1"
            className={hero ? "ring-primary-light/30 ring-1" : undefined}>
            <CardContent
                className={cn(
                    "flex flex-col items-center gap-5",
                    hero ? "px-6 py-10 text-center" : "p-5",
                )}>
                {hero}

                <div className="flex w-full flex-col gap-6 text-left">
                    {curatedProviders.length > 0 && (
                        <div className="flex flex-col gap-2.5">
                            <p className="text-text-tertiary text-xs font-semibold tracking-wide uppercase">
                                Providers
                            </p>
                            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                {curatedProviders.map((p) => (
                                    <ProviderGridCard
                                        key={p.id}
                                        provider={p}
                                        onPick={onPickProvider}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {customProviders.length > 0 && (
                        <div className="flex flex-col gap-2.5">
                            <p className="text-text-tertiary text-xs font-semibold tracking-wide uppercase">
                                Custom &amp; self-hosted
                            </p>
                            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                {customProviders.map((p) => (
                                    <ProviderGridCard
                                        key={p.id}
                                        provider={p}
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
