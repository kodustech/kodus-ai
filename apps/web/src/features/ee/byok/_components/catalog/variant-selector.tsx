"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { ExternalLinkIcon } from "lucide-react";

import type { ModelVariant } from "../../_data/curated-models.types";

/**
 * Plan / connection-variant toggle for a model that ships more than one billing
 * endpoint (e.g. Kimi "Developer API" vs "Kimi Code Plan"). Selecting a variant
 * repoints the endpoint; the caller reconciles the key when the account differs.
 */
export function VariantSelector({
    variants,
    selectedId,
    docsUrl,
    onSelect,
    disabledVariantIds,
}: {
    variants: ModelVariant[];
    selectedId?: string;
    docsUrl?: string;
    onSelect: (id: string) => void;
    disabledVariantIds?: Set<string>;
}) {
    const selected = variants.find((v) => v.id === selectedId);
    const isDisabledVariant = (id: string) => disabledVariantIds?.has(id);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary text-xs font-medium">
                    Plan
                </span>
                {docsUrl && (
                    <a
                        href={docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-light inline-flex items-center gap-1 text-xs hover:underline">
                        Which plan do I pick?
                        <ExternalLinkIcon size={11} />
                    </a>
                )}
            </div>
            <ToggleGroup.Root
                type="single"
                value={selectedId}
                onValueChange={(nextId) => {
                    if (nextId && isDisabledVariant(nextId)) return;
                    onSelect(nextId);
                }}
                className="bg-card-lv2 grid auto-cols-fr grid-flow-col gap-px overflow-hidden rounded-lg p-0.5">
                {variants.map((v) => (
                    <ToggleGroup.Item
                        key={v.id}
                        value={v.id}
                        disabled={isDisabledVariant(v.id)}
                        className="text-text-secondary hover:text-text-primary data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:ring-primary/40 data-[state=on]:shadow-sm rounded-md px-3 py-2 text-xs font-medium transition-colors data-[disabled]:opacity-40 data-[disabled]:pointer-events-none data-[state=on]:ring-1">
                        {v.label}
                        {isDisabledVariant(v.id) && (
                            <span className="ml-1.5 text-xs">
                                (Coming Soon)
                            </span>
                        )}
                    </ToggleGroup.Item>
                ))}
            </ToggleGroup.Root>
            {selected?.description && !isDisabledVariant(selected.id) && (
                <p className="text-text-tertiary text-xs text-pretty">
                    {selected.description}
                </p>
            )}
        </div>
    );
}
