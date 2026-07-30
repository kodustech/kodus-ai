"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import {
    clearModelOverrides,
    listModelOverrides,
    type ListModelOverridesResult,
    type ModelOverrideEntry,
} from "@services/organizationParameters/fetch";
import { AlertTriangleIcon } from "lucide-react";

const targetOf = (o: ModelOverrideEntry) => ({
    repositoryId: o.repositoryId,
    directoryId: o.directoryId,
});

const locationLabel = (o: ModelOverrideEntry): string => {
    if (o.scope === "global") return "Global default";
    if (o.scope === "directory") {
        return `${o.repositoryName ?? o.repositoryId ?? "repository"} · ${
            o.directoryName ?? o.directoryId ?? "directory"
        }`;
    }
    return o.repositoryName ?? o.repositoryId ?? "repository";
};

const confirmClear = (count: number): Promise<boolean> =>
    new Promise((resolve) => {
        magicModal.show(() => (
            <ConfirmModal
                open
                title="Clear mismatched model overrides?"
                description={`This resets ${count} per-repository/directory model override${
                    count === 1 ? "" : "s"
                } to inherit your BYOK main model. You can set them again later.`}
                confirmText="Clear overrides"
                variant="primary-dark"
                onConfirm={() => {
                    resolve(true);
                    magicModal.hide();
                }}
                onCancel={() => {
                    resolve(false);
                    magicModal.hide();
                }}
            />
        ));
    });

/**
 * Surfaces per-repo/dir `byokModel` overrides that don't match the org's current
 * main BYOK provider (typically after a provider change) and offers to bulk-clear
 * them. Renders nothing when there are no mismatches.
 */
export const ModelOverridesBanner = ({ teamId }: { teamId?: string }) => {
    const [data, setData] = useState<ListModelOverridesResult | null>(null);
    const [clearing, setClearing] = useState(false);

    const load = () => {
        if (!teamId) return;
        return listModelOverrides(teamId)
            .then(setData)
            .catch(() => setData(null));
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [teamId]);

    const mismatched = (data?.overrides ?? []).filter(
        (o) => o.inCurrentProviderCatalog === false,
    );
    if (mismatched.length === 0) return null;

    const onClear = async () => {
        if (!teamId) return;
        if (!(await confirmClear(mismatched.length))) return;
        setClearing(true);
        try {
            const res = await clearModelOverrides(
                teamId,
                mismatched.map(targetOf),
            );
            toast({
                description: `Cleared ${res.clearedCount} override${
                    res.clearedCount === 1 ? "" : "s"
                }.`,
                variant: "success",
            });
            await load();
        } catch {
            toast({
                title: "Error",
                description: "Could not clear the overrides. Please try again.",
                variant: "danger",
            });
        } finally {
            setClearing(false);
        }
    };

    return (
        <Alert variant="warning" className="mb-4">
            <AlertTriangleIcon />
            <AlertTitle>
                {mismatched.length}{" "}
                {mismatched.length === 1
                    ? "scope has a model override"
                    : "scopes have model overrides"}{" "}
                that don&apos;t match your current provider
            </AlertTitle>
            <AlertDescription>
                <p className="mb-2 text-sm">
                    These overrides were set for a different BYOK provider
                    {data?.provider ? ` (now ${data.provider})` : ""}. Reviews
                    there will fail or fall back until they&apos;re updated or
                    cleared.
                </p>
                <ul className="mb-3 space-y-0.5">
                    {mismatched.slice(0, 6).map((o, i) => (
                        <li key={`${o.repositoryId ?? "g"}-${o.directoryId ?? ""}-${i}`} className="text-xs">
                            <span className="font-medium">
                                {locationLabel(o)}
                            </span>
                            : <code>{o.model}</code>
                        </li>
                    ))}
                    {mismatched.length > 6 && (
                        <li className="text-text-tertiary text-xs">
                            …and {mismatched.length - 6} more
                        </li>
                    )}
                </ul>
                <Button
                    size="xs"
                    variant="helper"
                    loading={clearing}
                    disabled={clearing}
                    onClick={onClear}>
                    Clear overrides
                </Button>
            </AlertDescription>
        </Alert>
    );
};
