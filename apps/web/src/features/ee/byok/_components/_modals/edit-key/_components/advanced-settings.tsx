"use client";

import { useEffect } from "react";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Separator } from "@components/ui/separator";
import { Textarea } from "@components/ui/textarea";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
    BrainCircuitIcon,
    ExternalLinkIcon,
    Settings2Icon,
} from "lucide-react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useModelCapabilities } from "@services/organizationParameters/hooks";

import type { EditKeyForm } from "../_types";
import { ADVANCED_FIELDS } from "./credential-forms";

const THINKING_OPTIONS = [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "custom", label: "Custom" },
] as const;

// Generic fallback when the provider module ships no example of its own.
const DEFAULT_REASONING_OVERRIDE_EXAMPLE = `{\n  "thinking": { "type": "enabled" }\n}`;

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
                    <FormControl.Label htmlFor={name}>
                        {label}
                    </FormControl.Label>
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
    const { control, setValue } = useFormContext<EditKeyForm>();
    // useWatch (a hook), not watch(): the React Compiler is enabled for this
    // app and memoizes `watch("name")` — a plain call on a stable function
    // with a constant argument — so its result froze at the first render and
    // the Custom textarea never appeared when the toggle changed.
    const currentEffort = useWatch({ control, name: "reasoningEffort" });
    const configOverride = useWatch({
        control,
        name: "reasoningConfigOverride",
    });
    const isCustom = currentEffort === "custom";
    const currentProvider = useWatch({ control, name: "provider" });
    const currentModel = useWatch({ control, name: "model" });
    // Provider-specific advanced fields (e.g. OpenRouter upstream pinning) come
    // from the registry — no `provider === "x"` branch in this shared component.
    const AdvancedFields = currentProvider
        ? ADVANCED_FIELDS[currentProvider]
        : undefined;

    // Per-model capabilities come from the PROVIDER module (server-side), never a
    // hand-coded web mirror — so which models reject temperature / can reason, and
    // the Custom-override example, are owned in one place the community contributes
    // to. Until the answer arrives we stay permissive (show temperature, allow
    // reasoning) to avoid a flicker that hides a valid field.
    const { data: caps } = useModelCapabilities({
        provider: currentProvider,
        model: currentModel,
        enabled: !!currentProvider && !!currentModel,
    });

    // The Custom reasoning-override example is the provider's own (module-owned);
    // fall back to a generic enabled-thinking shape until/if none is provided.
    const customPlaceholder =
        caps?.reasoningOverrideExample ?? DEFAULT_REASONING_OVERRIDE_EXAMPLE;

    // Temperature: hidden (not shown-but-ignored) for models that reject sampling
    // params (OpenAI gpt-5/o-series, Anthropic 4.7+). Clearing the stored value
    // matters as much as hiding: a config saved before the model was switched
    // would otherwise keep submitting a temperature the provider 400s on.
    const temperatureUnsupported = !!caps && !caps.supportsTemperature;
    useEffect(() => {
        if (temperatureUnsupported) {
            setValue("temperature", null, { shouldDirty: true });
        }
    }, [temperatureUnsupported, setValue]);

    // Reasoning: the toggle mirrors what the model can actually do. When the model
    // can't reason, lock it to Off; when it can but only at certain levels (e.g.
    // gpt-5 → medium/high), disable the invalid ones. An effort that becomes
    // invalid after a model switch is cleared so we never submit one the provider
    // rejects.
    const reasoningUnsupported = !!caps && !caps.supportsReasoning;
    const allowedLevels = caps?.reasoningOptions ?? [];
    const isLevelAllowed = (value: string) =>
        value === "none" ||
        value === "custom" ||
        allowedLevels.length === 0 ||
        allowedLevels.includes(value as "low" | "medium" | "high");
    useEffect(() => {
        if (!caps) return;
        if (reasoningUnsupported && currentEffort) {
            setValue("reasoningEffort", null, { shouldDirty: true });
            setValue("reasoningConfigOverride", null, { shouldDirty: true });
            return;
        }
        // A saved level the model no longer accepts (e.g. "low" on a gpt-5) →
        // back to Off. Custom is a free-form override, left untouched.
        if (
            currentEffort &&
            currentEffort !== "none" &&
            currentEffort !== "custom" &&
            !isLevelAllowed(currentEffort)
        ) {
            setValue("reasoningEffort", null, { shouldDirty: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [caps, reasoningUnsupported, currentEffort, setValue]);

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
                                        (configOverride ? "custom" : "none")
                                    }
                                    onValueChange={(value) => {
                                        if (!value) return;
                                        // "Off" MUST persist as the explicit
                                        // 'none' effort — mapping it to null made
                                        // it indistinguishable from "unset", which
                                        // the read resolves to the catalog default
                                        // (medium), so Off could never be saved.
                                        field.onChange(value);
                                    }}>
                                    {THINKING_OPTIONS.map((opt) => {
                                        // Off is always available; every other
                                        // option is gated by the model's declared
                                        // reasoning support + valid levels.
                                        const disabled =
                                            opt.value !== "none" &&
                                            (reasoningUnsupported ||
                                                !isLevelAllowed(opt.value));
                                        return (
                                            <ToggleGroup.Item
                                                key={opt.value}
                                                value={opt.value}
                                                disabled={disabled}
                                                className="text-text-secondary hover:text-text-primary data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:ring-primary/40 rounded-md px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-secondary data-[state=on]:shadow-sm data-[state=on]:ring-1">
                                                {opt.label}
                                            </ToggleGroup.Item>
                                        );
                                    })}
                                </ToggleGroup.Root>
                            )}
                        />

                        {reasoningUnsupported && (
                            <p className="text-text-tertiary text-xs">
                                This model doesn&apos;t support reasoning — it
                                always runs without a thinking budget.
                            </p>
                        )}

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
                                                    Paste the options directly —
                                                    Kodus wraps them under the
                                                    active provider&apos;s
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

                        {!isCustom &&
                            currentEffort &&
                            currentEffort !== "none" && (
                                <p className="text-text-tertiary text-xs">
                                    Mapped automatically to your provider
                                    (Claude extended thinking, Gemini thinking
                                    level, OpenAI reasoning effort).
                                </p>
                            )}
                    </div>

                    <Separator className="bg-card-lv2" />

                    {/* ── Model Parameters ──────────────────── */}
                    <div className="grid grid-cols-2 gap-4">
                        {!temperatureUnsupported && (
                            <NumberField
                                name="temperature"
                                label="Temperature"
                                placeholder="Default"
                                helper="0 = deterministic, 2 = creative"
                            />
                        )}
                        <NumberField
                            name="maxOutputTokens"
                            label="Max output tokens"
                            placeholder="Default"
                            helper="Empty uses model default"
                        />
                    </div>

                    {temperatureUnsupported && (
                        <p className="text-text-tertiary text-xs text-pretty">
                            Claude 4.7 and newer removed temperature — the
                            provider rejects any request that sets it. Steer the
                            model with the thinking level above instead.
                        </p>
                    )}

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

                    {AdvancedFields && <AdvancedFields />}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};
