"use client";

import { ComponentProps, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import {
    getSpendLimitConfig,
    updateSpendLimit,
} from "@services/spend-limit/fetch";
import type {
    ManualPricingOverrides,
    ModelTokenRates,
    ResolvedModelPricing,
} from "@services/spend-limit/types";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, WalletIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

const TOKENS_PER_MILLION = 1_000_000;

const PRICE_FIELDS = [
    { key: "input", label: "Input" },
    { key: "output", label: "Output" },
    { key: "cacheRead", label: "Cache read" },
    { key: "cacheWrite", label: "Cache write" },
] as const;

type PriceField = (typeof PRICE_FIELDS)[number]["key"];
type ModelPrices = Record<PriceField, string>;

/** per-token rate -> "$ / 1M tokens" string for display/editing. */
const toPerMillion = (perToken: number): string => {
    if (!Number.isFinite(perToken) || perToken <= 0) return "";
    return String(Number((perToken * TOKENS_PER_MILLION).toFixed(6)));
};

/** "$ / 1M" string -> per-token rate. Empty is treated as 0; invalid as null. */
const fromPerMillion = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return 0;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed / TOKENS_PER_MILLION;
};

const ratesToFields = (rates: ModelTokenRates): ModelPrices => ({
    input: toPerMillion(rates.input.default),
    output: toPerMillion(rates.output.default),
    cacheRead: toPerMillion(rates.cacheRead.default),
    cacheWrite: toPerMillion(rates.cacheWrite.default),
});

const seedPrices = (model: ResolvedModelPricing): ModelPrices =>
    ratesToFields(model.rates);

/** The catalog rates as editable fields, or null when the catalog can't price it. */
const catalogFieldsOf = (model: ResolvedModelPricing): ModelPrices | null =>
    model.catalogRates ? ratesToFields(model.catalogRates) : null;

const fieldsEqual = (a: ModelPrices, b: ModelPrices): boolean =>
    PRICE_FIELDS.every((f) => a[f.key] === b[f.key]);

/**
 * Numeric equality between two per-model price maps — compares the resolved
 * per-token rate, NOT the raw display string. `toPerMillion` normalizes trailing
 * zeros, so "0.1234" and "0.12340" are the same price; a string compare would
 * mark them different and falsely enable Save.
 */
const priceMapsEqual = (
    a: Record<string, ModelPrices>,
    b: Record<string, ModelPrices>,
): boolean => {
    const modelsUnion = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const model of modelsUnion) {
        const pa = a[model];
        const pb = b[model];
        if (!pa || !pb) return false;
        if (
            PRICE_FIELDS.some(
                (f) => fromPerMillion(pa[f.key]) !== fromPerMillion(pb[f.key]),
            )
        ) {
            return false;
        }
    }
    return true;
};

/** A model is priceable once it charges for input or output (cache is optional). */
const isModelPriceable = (prices: ModelPrices): boolean => {
    const input = fromPerMillion(prices.input);
    const output = fromPerMillion(prices.output);
    const cacheRead = fromPerMillion(prices.cacheRead);
    const cacheWrite = fromPerMillion(prices.cacheWrite);
    if ([input, output, cacheRead, cacheWrite].some((v) => v === null)) {
        return false;
    }
    return (input ?? 0) > 0 || (output ?? 0) > 0;
};

export const SpendLimitSection = ({ teamId }: { teamId?: string }) => {
    const { data, isLoading, refetch } = useQuery({
        queryKey: ["spend-limit", teamId],
        queryFn: () => getSpendLimitConfig(teamId),
        retry: false,
    });

    const [enabled, setEnabled] = useState(false);
    const [monthlyLimit, setMonthlyLimit] = useState("");
    const [prices, setPrices] = useState<Record<string, ModelPrices>>({});
    const [isSaving, setIsSaving] = useState(false);

    // Seed editable state from the fetched config. External-data sync, so an
    // effect is appropriate; keyed on the payload identity.
    useEffect(() => {
        if (!data) return;
        setEnabled(data.enabled);
        setMonthlyLimit(
            data.monthlyLimitUsd > 0 ? String(data.monthlyLimitUsd) : "",
        );
        setPrices(
            Object.fromEntries(
                data.models.map((m) => [m.model, seedPrices(m)]),
            ),
        );
    }, [data]);

    const models = data?.models ?? [];

    // A model is unpriceable only when its current values aren't a valid price
    // AND the catalog can't price it either (so it can't fall back).
    const unpriceableModels = useMemo(
        () =>
            models
                .filter(
                    (m) =>
                        !isModelPriceable(prices[m.model] ?? seedPrices(m)) &&
                        !m.catalogRates,
                )
                .map((m) => m.model),
        [models, prices],
    );
    const allPriceable = unpriceableModels.length === 0;

    // Dirty check: only enable "Save" when the form actually differs from the
    // loaded config — so the button isn't lit when nothing changed. Mirrors the
    // exact seeding done in the effect above.
    const isDirty = useMemo(() => {
        const seededEnabled = data?.enabled ?? false;
        const seededLimit =
            data && data.monthlyLimitUsd > 0
                ? String(data.monthlyLimitUsd)
                : "";
        const seededPrices = data
            ? Object.fromEntries(
                  data.models.map((m) => [m.model, seedPrices(m)]),
              )
            : {};
        return (
            enabled !== seededEnabled ||
            monthlyLimit !== seededLimit ||
            !priceMapsEqual(prices, seededPrices)
        );
    }, [data, enabled, monthlyLimit, prices]);

    const updatePrice = (model: string, field: PriceField, value: string) => {
        setPrices((prev) => ({
            ...prev,
            [model]: { ...prev[model], [field]: value },
        }));
    };

    // Reverting to catalog is just setting the inputs back to the catalog
    // values: buildOverrides then sees current == catalog and sends no
    // override, so the model resolves at live catalog rates.
    const revertToCatalog = (model: ResolvedModelPricing) => {
        const catalog = catalogFieldsOf(model);
        if (!catalog) return;
        setPrices((prev) => ({ ...prev, [model.model]: catalog }));
    };

    /**
     * The authoritative set of manual overrides. A model gets one only when
     * its current values are a valid price that differs from the catalog —
     * catalog-matching (or invalid) models are omitted so they resolve at live
     * catalog rates. Always returns an object (never undefined) so the backend
     * replaces the stored set rather than keeping the old one.
     */
    const buildOverrides = (): ManualPricingOverrides => {
        const overrides: ManualPricingOverrides = {};
        for (const model of models) {
            const current = prices[model.model];
            if (!current) continue;

            const catalog = catalogFieldsOf(model);
            if (catalog && fieldsEqual(current, catalog)) continue; // live catalog
            if (!isModelPriceable(current)) continue; // fall back to catalog/none

            overrides[model.model] = {
                input: fromPerMillion(current.input) ?? 0,
                output: fromPerMillion(current.output) ?? 0,
                cacheRead: fromPerMillion(current.cacheRead) ?? 0,
                cacheWrite: fromPerMillion(current.cacheWrite) ?? 0,
            };
        }
        return overrides;
    };

    const limitValue = Number(monthlyLimit);
    const limitIsValid = monthlyLimit.trim() !== "" && limitValue > 0;

    const handleSave = async () => {
        if (enabled && !limitIsValid) {
            toast({
                variant: "danger",
                title: "Enter a positive monthly limit to enable alerts.",
            });
            return;
        }
        if (enabled && !allPriceable) {
            toast({
                variant: "danger",
                title: "Add a price for every model before enabling.",
                description: `No price for: ${unpriceableModels.join(", ")}.`,
            });
            return;
        }

        setIsSaving(true);
        try {
            await updateSpendLimit({
                enabled,
                monthlyLimitUsd: limitIsValid ? limitValue : 0,
                modelPricing: buildOverrides(),
                teamId,
            });
            toast({ variant: "success", title: "Spend limit saved" });
            await refetch();
        } catch (error) {
            const unpriceable = (
                error as {
                    response?: { data?: { unpriceableModels?: string[] } };
                }
            )?.response?.data?.unpriceableModels;
            toast({
                variant: "danger",
                title: "Couldn't save spend limit",
                description: unpriceable?.length
                    ? `No price found for: ${unpriceable.join(", ")}.`
                    : undefined,
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <span className="text-text-secondary">
                    <WalletIcon size={16} />
                </span>
                <div className="flex flex-col">
                    <h3 className="text-text-primary text-sm font-semibold text-balance">
                        Monthly spend limit
                    </h3>
                    <p className="text-text-tertiary text-xs text-pretty">
                        Get alerted as your BYOK spend approaches a monthly cap.
                        Alerts only — reviews keep running. Set a hard cap with
                        your provider to actually stop spend.
                    </p>
                </div>
            </div>

            {isLoading ? (
                <SpendLimitSkeleton />
            ) : models.length === 0 ? (
                <Card color="lv1" className="border-card-lv2 border-dashed">
                    <CardContent className="py-4">
                        <p className="text-text-secondary text-sm text-pretty">
                            Configure a BYOK model above to set a monthly spend
                            limit.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between gap-6">
                            <div className="flex flex-col gap-1">
                                <Label
                                    htmlFor="spend-limit-enabled"
                                    className="text-text-primary text-sm font-medium">
                                    Enable spend alerts
                                </Label>
                                <p className="text-text-secondary text-sm text-pretty">
                                    Notify at 50%, 75%, 90% and 100% of the
                                    monthly limit.
                                </p>
                            </div>
                            <Switch
                                id="spend-limit-enabled"
                                checked={enabled}
                                onCheckedChange={setEnabled}
                            />
                        </CardHeader>
                        <CardContent>
                            <Label
                                htmlFor="spend-limit-amount"
                                className="text-sm font-medium">
                                Monthly limit (US$)
                            </Label>
                            <Input
                                id="spend-limit-amount"
                                inputMode="decimal"
                                placeholder="1000"
                                value={monthlyLimit}
                                onChange={(ev) =>
                                    setMonthlyLimit(ev.target.value)
                                }
                                className={cn(
                                    "mt-1.5 max-w-48 tabular-nums",
                                    enabled && !limitIsValid && "border-danger",
                                )}
                            />
                            {enabled && !limitIsValid && (
                                <p className="text-danger mt-1.5 text-xs">
                                    Enter an amount greater than 0.
                                </p>
                            )}
                        </CardContent>
                    </Card>

                    {!allPriceable && (
                        <Alert variant="warning">
                            <AlertTriangleIcon />
                            <AlertTitle className="text-balance">
                                Some models have no price yet
                            </AlertTitle>
                            <AlertDescription className="text-pretty">
                                We couldn't find a price for{" "}
                                <strong className="text-text-primary">
                                    {unpriceableModels.join(", ")}
                                </strong>
                                . Enter the per-token prices below to enable the
                                limit — spend can't be tracked for a model we
                                can't price.
                            </AlertDescription>
                        </Alert>
                    )}

                    <div className="flex flex-col gap-2">
                        <p className="text-text-secondary text-sm text-pretty">
                            Prices we found per model. Check them against your
                            provider and adjust if needed.
                        </p>
                        {models.map((model) => (
                            <ModelPricingCard
                                key={model.model}
                                model={model}
                                prices={
                                    prices[model.model] ?? seedPrices(model)
                                }
                                onChange={(field, value) =>
                                    updatePrice(model.model, field, value)
                                }
                                onRevert={() => revertToCatalog(model)}
                            />
                        ))}
                    </div>

                    <Button
                        type="button"
                        size="md"
                        variant="primary"
                        className="self-start"
                        loading={isSaving}
                        disabled={
                            isSaving ||
                            // Nothing changed since the last save → keep it off.
                            !isDirty ||
                            // Alerts ON needs a valid limit + every model priced.
                            // (Prices alone still save with alerts OFF — decoupled.)
                            (enabled && (!limitIsValid || !allPriceable))
                        }
                        onClick={handleSave}>
                        Save spend limit
                    </Button>
                </>
            )}
        </section>
    );
};

const SOURCE_BADGE: Record<
    ResolvedModelPricing["source"],
    { variant: ComponentProps<typeof Badge>["variant"]; label: string }
> = {
    catalog: { variant: "secondary", label: "Catalog" },
    manual: { variant: "primary-dark", label: "Manual" },
    none: { variant: "error", label: "No price" },
};

function ModelPricingCard({
    model,
    prices,
    onChange,
    onRevert,
}: {
    model: ResolvedModelPricing;
    prices: ModelPrices;
    onChange: (field: PriceField, value: string) => void;
    onRevert: () => void;
}) {
    const catalog = catalogFieldsOf(model);
    const matchesCatalog = catalog ? fieldsEqual(prices, catalog) : false;

    // Effective source reflects what will actually be used on save: catalog
    // when the inputs match the catalog, manual when they deviate, none when
    // there's no usable price.
    const source: ResolvedModelPricing["source"] = !isModelPriceable(prices)
        ? "none"
        : matchesCatalog
          ? "catalog"
          : "manual";
    const badge = SOURCE_BADGE[source];

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
                <span className="text-text-primary truncate text-sm font-medium">
                    {model.model}
                </span>
                <Badge variant={badge.variant} className="shrink-0">
                    {badge.label}
                </Badge>
            </CardHeader>
            <CardContent>
                <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {PRICE_FIELDS.map((field) => {
                            const id = `${model.model}-${field.key}`;
                            return (
                                <div
                                    key={field.key}
                                    className="flex flex-col gap-1">
                                    <Label
                                        htmlFor={id}
                                        className="text-text-tertiary text-xs">
                                        {field.label} ($/1M)
                                    </Label>
                                    <Input
                                        id={id}
                                        inputMode="decimal"
                                        placeholder="0"
                                        value={prices[field.key]}
                                        onChange={(ev) =>
                                            onChange(field.key, ev.target.value)
                                        }
                                        className="tabular-nums"
                                    />
                                </div>
                            );
                        })}
                    </div>
                    {catalog && !matchesCatalog && (
                        <Button
                            type="button"
                            size="xs"
                            variant="cancel"
                            className="self-start"
                            onClick={onRevert}>
                            Revert to catalog price
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

function SpendLimitSkeleton() {
    return (
        <div className="flex flex-col gap-2" aria-hidden>
            <div className="bg-card-lv2 h-20 animate-pulse rounded-xl" />
            <div className="bg-card-lv2 h-28 animate-pulse rounded-xl" />
        </div>
    );
}
