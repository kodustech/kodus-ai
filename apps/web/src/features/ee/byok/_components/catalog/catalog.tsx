"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { SettingsIcon } from "lucide-react";
import Link from "next/link";

import curatedCatalog from "../../_data/curated-models.json";
import type { CuratedModel } from "../../_data/curated-models.types";
import type { BYOKConfig } from "../../_types";
import { CuratedConnectPanel } from "./connect-panel";
import { CuratedModelCard } from "./model-card";

export function CuratedCatalog({
    slot,
    existingConfig,
    existingKeyByProvider,
    onSave,
    onCancel,
    showManualLink = true,
}: {
    slot: "main" | "fallback";
    existingConfig?: BYOKConfig;
    existingKeyByProvider?: Partial<Record<string, string>>;
    onSave: (_: BYOKConfig) => Promise<void>;
    onCancel?: () => void;
    showManualLink?: boolean;
}) {
    const [selected, setSelected] = useState<CuratedModel | null>(null);

    const recommended = (curatedCatalog.models as CuratedModel[]).filter(
        (m) => m.tier === "recommended",
    );

    if (selected) {
        return (
            <CuratedConnectPanel
                model={selected}
                existingConfig={
                    existingConfig?.model === selected.id
                        ? existingConfig
                        : undefined
                }
                existingKey={existingKeyByProvider?.[selected.provider]}
                onBack={() => setSelected(null)}
                onSave={onSave}
            />
        );
    }

    return (
        <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {recommended.map((model) => (
                    <CuratedModelCard
                        key={model.id}
                        model={model}
                        onSelect={() => setSelected(model)}
                    />
                ))}
            </div>

            <div className="border-card-lv2 flex items-center justify-between gap-4 border-t pt-5">
                {showManualLink ? (
                    <p className="text-text-secondary text-xs text-pretty">
                        Need a provider or model not listed above?
                    </p>
                ) : (
                    <span />
                )}

                <div className="flex items-center gap-2">
                    {onCancel && (
                        <Button
                            type="button"
                            size="sm"
                            variant="cancel"
                            onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    {showManualLink && (
                        <Link href={`/organization/byok/manual?slot=${slot}`}>
                            <Button
                                type="button"
                                size="sm"
                                variant="helper"
                                leftIcon={<SettingsIcon />}>
                                Configure manually
                            </Button>
                        </Link>
                    )}
                </div>
            </div>
        </div>
    );
}
