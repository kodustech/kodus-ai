"use client";

import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Separator } from "@components/ui/separator";
import { Switch } from "@components/ui/switch";
import { Textarea } from "@components/ui/textarea";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
    BrainCircuitIcon,
    ExternalLinkIcon,
    Settings2Icon,
} from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";

const THINKING_OPTIONS = [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "custom", label: "Custom" },
] as const;

const CUSTOM_PLACEHOLDERS: Record<string, string> = {
    anthropic: `{\n  "thinking": { "type": "enabled", "budgetTokens": 25000 }\n}`,
    google_gemini: `{\n  "thinkingConfig": { "thinkingBudget": 16000 }\n}`,
    google_vertex: `{\n  "thinkingConfig": { "thinkingBudget": 16000 }\n}`,
    openai: `{\n  "reasoningEffort": "high",\n  "serviceTier": "flex"\n}`,
    open_router: `{\n  "reasoning": { "effort": "high" },\n  "ignore": ["deepinfra"]\n}`,
    openai_compatible: `{\n  "thinking": { "type": "enabled" }\n}`,
    novita: `{\n  "thinking": { "type": "enabled" }\n}`,
};

function getCustomPlaceholder(provider: string | undefined): string {
    return (
        (provider && CUSTOM_PLACEHOLDERS[provider]) ??
        `{\n  "thinking": { "type": "enabled" }\n}`
    );
}

const NumberField = ({
    name,
    label,
    placeholder,
    helper,
}: {
    name: keyof EditKeyForm;
    label: string;
    placeholder: string;
    helper: string;
}) => {
    const { control } = useFormContext<EditKeyForm>();

    return (
        <Controller
            name={name}
            control={control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={name}>{label}</FormControl.Label>
                    <FormControl.Input>
                        <Input
                            id={name}
                            type="number"
                            min={0}
                            step={name === "temperature" ? 0.1 : 1}
                            max={name === "temperature" ? 2 : undefined}
                            placeholder={placeholder}
                            error={fieldState.error}
                            value={
                                typeof field.value === "number"
                                    ? field.value
                                    : ""
                            }
                            onChange={(e) => {
                                const val = e.target.value;
                                const num =
                                    name === "temperature"
                                        ? parseFloat(val)
                                        : parseInt(val, 10);
                                field.onChange(
                                    val === "" || Number.isNaN(num)
                                        ? null
                                        : num,
                                );
                            }}
                        />
                    </FormControl.Input>
                    <FormControl.Helper>{helper}</FormControl.Helper>
                    <FormControl.Error>
                        {fieldState.error?.message}
                    </FormControl.Error>
                </FormControl.Root>
            )}
        />
    );
};

export const ByokAdvancedSettings = ({
    defaultOpen = false,
}: {
    defaultOpen?: boolean;
}) => {
    const { control, watch } = useFormContext<EditKeyForm>();
    const currentEffort = watch("reasoningEffort");
    const isCustom = currentEffort === ("custom" as string);
    const currentProvider = watch("provider");
    const isOpenRouter = currentProvider === "open_router";
    const customPlaceholder = getCustomPlaceholder(currentProvider);

    return (
        <Collapsible
            defaultOpen={defaultOpen}
            className="border-card-lv2 rounded-lg border">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="text-text-secondary hover:text-text-primary hover:bg-card-lv2/40 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors data-[state=open]:rounded-b-none">
                    <span className="flex items-center gap-2">
                        <Settings2Icon className="size-4" />
                        Advanced settings
                    </span>
                    <CollapsibleIndicator />
                </button>
            </CollapsibleTrigger>

            <CollapsibleContent>
                <div className="border-card-lv2 flex flex-col gap-5 border-t px-3 pt-4">
                    {/* ── Thinking / Reasoning ──────────────── */}
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <BrainCircuitIcon className="text-text-secondary size-4" />
                            <span className="text-text-primary text-sm font-medium">
                                Thinking / Reasoning
                            </span>
                        </div>

                        <Controller
                            name="reasoningEffort"
                            control={control}
                            render={({ field }) => (
                                <ToggleGroup.Root
                                    type="single"
                                    className="bg-card-lv2 grid grid-cols-5 gap-px overflow-hidden rounded-lg p-0.5"
                                    value={
                                        field.value ??
                                        (watch("reasoningConfigOverride")
                                            ? "custom"
                                            : "none")
                                    }
                                    onValueChange={(value) => {
                                        if (!value) return;
                                        field.onChange(
                                            value === "none" ? null : value,
                                        );
                                    }}>
                                    {THINKING_OPTIONS.map((opt) => (
                                        <ToggleGroup.Item
                                            key={opt.value}
                                            value={opt.value}
                                            className="text-text-secondary hover:text-text-primary data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:ring-primary/40 data-[state=on]:shadow-sm rounded-md px-2 py-1.5 text-xs font-medium transition-colors data-[state=on]:ring-1">
                                            {opt.label}
                                        </ToggleGroup.Item>
                                    ))}
                                </ToggleGroup.Root>
                            )}
                        />

                        {isCustom && (
                            <Controller
                                name="reasoningConfigOverride"
                                control={control}
                                render={({ field, fieldState }) => (
                                    <FormControl.Root>
                                        <FormControl.Input>
                                            <Textarea
                                                className="font-mono text-xs leading-relaxed"
                                                rows={4}
                                                placeholder={customPlaceholder}
                                                value={field.value ?? ""}
                                                onChange={(e) =>
                                                    field.onChange(
                                                        e.target.value || null,
                                                    )
                                                }
                                            />
                                        </FormControl.Input>
                                        <FormControl.Helper>
                                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                <span>
                                                    Paste the options directly
                                                    — Kodus wraps them under
                                                    the active provider's
                                                    namespace automatically.
                                                </span>
                                                <a
                                                    href="https://docs.kodus.io/how_to_use/en/byok#custom-json-override"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-primary-light inline-flex items-center gap-1 hover:underline">
                                                    See examples
                                                    <ExternalLinkIcon
                                                        size={11}
                                                    />
                                                </a>
                                            </span>
                                        </FormControl.Helper>
                                        <FormControl.Error>
                                            {fieldState.error?.message}
                                        </FormControl.Error>
                                    </FormControl.Root>
                                )}
                            />
                        )}

                        {!isCustom && currentEffort && currentEffort !== "none" && (
                            <p className="text-text-tertiary text-xs">
                                Mapped automatically to your provider (Claude
                                extended thinking, Gemini thinking level, OpenAI
                                reasoning effort).
                            </p>
                        )}
                    </div>

                    <Separator className="bg-card-lv2" />

                    {/* ── Model Parameters ──────────────────── */}
                    <div className="grid grid-cols-2 gap-4">
                        <NumberField
                            name="temperature"
                            label="Temperature"
                            placeholder="Default"
                            helper="0 = deterministic, 2 = creative"
                        />
                        <NumberField
                            name="maxOutputTokens"
                            label="Max output tokens"
                            placeholder="Default"
                            helper="Empty uses model default"
                        />
                    </div>

                    <Separator className="bg-card-lv2" />

                    {/* ── Limits ────────────────────────────── */}
                    <div className="grid grid-cols-2 gap-4">
                        <NumberField
                            name="maxInputTokens"
                            label="Max input tokens"
                            placeholder="No limit"
                            helper="Context window cap"
                        />
                        <NumberField
                            name="maxConcurrentRequests"
                            label="Max concurrent requests"
                            placeholder="No limit"
                            helper="For rate-limited providers"
                        />
                    </div>

                    {isOpenRouter && <OpenRouterRoutingFields />}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};

const OpenRouterRoutingFields = () => {
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
