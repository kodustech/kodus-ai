"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import { ArrowLeftIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import curatedCatalog from "../_data/curated-models.json";
import type { CuratedModel } from "../_data/curated-models.types";
import type { BYOKConfig } from "../_types";
import { CuratedConnectPanel } from "./catalog/connect-panel";
import { CuratedModelCard, PROVIDER_LABELS } from "./catalog/model-card";
import { ProviderLogo } from "./provider-logo";

type ProviderChoice = { id: string; label: string; modelCount: number };

/**
 * The distinct providers in the curated catalog, in first-appearance order —
 * the provider-first entry point. Each carries a human label (the shared
 * PROVIDER_LABELS, falling back to the catalog's providerDisplayName) and how
 * many curated models it offers, so the picker can show "N models".
 */
export const catalogProviders = (): ProviderChoice[] => {
    const byId = new Map<string, ProviderChoice>();
    for (const m of curatedCatalog.models as CuratedModel[]) {
        const existing = byId.get(m.provider);
        if (existing) {
            existing.modelCount += 1;
            continue;
        }
        byId.set(m.provider, {
            id: m.provider,
            label:
                PROVIDER_LABELS[m.provider] ??
                m.providerDisplayName ??
                m.provider,
            modelCount: 1,
        });
    }
    return Array.from(byId.values());
};

const providerLabelFor = (
    providerId: string,
    providers: ProviderChoice[],
): string =>
    PROVIDER_LABELS[providerId] ??
    providers.find((p) => p.id === providerId)?.label ??
    providerId;

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
    onSave: (cfg: BYOKConfig) => Promise<void>;
    onCancel?: () => void;
    hero?: React.ReactNode;
    footer?: React.ReactNode;
}) {
    const providers = catalogProviders();
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
        const providerModels = (curatedCatalog.models as CuratedModel[])
            .filter((m) => m.provider === pickedProvider)
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {providerModels.map((model) => (
                            <CuratedModelCard
                                key={model.id}
                                model={model}
                                showConnect
                                onSelect={() => setSelected(model)}
                            />
                        ))}
                    </div>
                ) : (
                    <p className="text-text-tertiary text-sm text-pretty">
                        No catalog models for {label}. Use “Configure manually” to
                        add one.
                    </p>
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
                            variant="cancel"
                            onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                </CardContent>
            </Card>
        );
    }

    // The provider grid — the provider-first entry point.
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

                <div
                    className={cn(
                        "grid w-full max-w-xl grid-cols-2 gap-2.5 self-center sm:grid-cols-3",
                    )}>
                    {providers.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            onClick={() => setPickedProvider(p.id)}
                            className="border-card-lv2 bg-card-lv2 hover:border-primary-light/60 hover:bg-card-lv3 flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors">
                            <ProviderLogo
                                provider={p.id}
                                label={p.label}
                                className="size-8"
                            />
                            <span className="flex min-w-0 flex-col">
                                <span className="text-text-primary truncate text-sm font-semibold">
                                    {p.label}
                                </span>
                                <span className="text-text-tertiary text-xs tabular-nums">
                                    {p.modelCount}{" "}
                                    {p.modelCount === 1 ? "model" : "models"}
                                </span>
                            </span>
                        </button>
                    ))}
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
