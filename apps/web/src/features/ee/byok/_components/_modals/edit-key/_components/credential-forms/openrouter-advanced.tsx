"use client";

import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Separator } from "@components/ui/separator";
import { Switch } from "@components/ui/switch";
import { ExternalLinkIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../../_types";

/**
 * OpenRouter-only advanced fields — pin upstream providers + fallback toggle.
 * Rendered inside the Advanced settings section via the ADVANCED_FIELDS registry
 * (keyed by provider), so it isn't a `provider === "open_router"` special-case in
 * the shared advanced-settings component.
 */
export const OpenRouterRoutingFields = () => {
    const { control } = useFormContext<EditKeyForm>();

    return (
        <>
            <Separator className="bg-card-lv2" />

            <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="flex flex-col">
                        <span className="text-text-primary text-sm font-medium">
                            OpenRouter routing
                        </span>
                        <p className="text-text-tertiary text-xs text-pretty">
                            OpenRouter routes each request to a different
                            upstream by default. Pin providers here to avoid
                            quality and behavior drift between calls.
                        </p>
                    </div>
                    <a
                        href="https://docs.kodus.io/how_to_use/en/byok#pinning-openrouter-providers"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-light inline-flex shrink-0 items-center gap-1 text-xs hover:underline">
                        Learn more
                        <ExternalLinkIcon size={11} />
                    </a>
                </div>

                <Controller
                    name="openrouterProviderOrder"
                    control={control}
                    render={({ field, fieldState }) => {
                        const asCsv = Array.isArray(field.value)
                            ? field.value.join(", ")
                            : "";
                        return (
                            <FormControl.Root>
                                <FormControl.Label>
                                    Pin providers (in order)
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        size="md"
                                        placeholder="e.g. moonshot, together"
                                        value={asCsv}
                                        error={fieldState.error}
                                        onChange={(e) => {
                                            const raw = e.target.value;
                                            const parsed = raw
                                                .split(",")
                                                .map((s) => s.trim())
                                                .filter((s) => s.length > 0);
                                            field.onChange(
                                                parsed.length > 0
                                                    ? parsed
                                                    : null,
                                            );
                                        }}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper>
                                    Comma-separated upstream names. First
                                    available wins. Leave empty for OpenRouter
                                    default routing.
                                </FormControl.Helper>
                            </FormControl.Root>
                        );
                    }}
                />

                <Controller
                    name="openrouterAllowFallbacks"
                    control={control}
                    render={({ field }) => (
                        <FormControl.Root>
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex flex-col">
                                    <FormControl.Label>
                                        Allow fallbacks
                                    </FormControl.Label>
                                    <FormControl.Helper>
                                        When off, requests fail if none of the
                                        pinned providers are available (no
                                        silent routing to other upstreams).
                                    </FormControl.Helper>
                                </div>
                                <Switch
                                    checked={field.value ?? true}
                                    onCheckedChange={(v) => field.onChange(v)}
                                />
                            </div>
                        </FormControl.Root>
                    )}
                />
            </div>
        </>
    );
};
