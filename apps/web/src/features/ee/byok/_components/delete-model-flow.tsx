"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { deleteBYOK } from "@services/organizationParameters/fetch";
import { AlertTriangleIcon } from "lucide-react";
import { ConfirmModal } from "src/core/components/ui/confirm-modal";

import { formatModelLabel } from "../_data/model-label";
import type { BYOKConfig, BYOKModelConfig } from "../_types";
import { groupModelsByProvider } from "../_utils";

/** Cap the rejection list at the ModelOverridesBanner pattern (first 6). */
const REASON_CAP = 6;

/**
 * The backend guard (delete-byok-config.use-case.ts) throws ONE joined string
 * when a model is in use — e.g.
 *   `Model "openai:gpt-x" is in use and cannot be deleted. Remove these
 *    references first: routing default; repository "api-core" (byokModelId).`
 * The usages are joined with "; ", so the inverse is a split on "; ". This marker
 * anchors the tail; text before it (which carries the model ID, not the name) is
 * dropped — the UI sources the human model NAME locally instead.
 */
const REFS_MARKER = "Remove these references first:";

/** Best-effort extraction of the API error message from the axios/Nest envelope. */
function extractMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (!error || typeof error !== "object") return "";

    const data = (error as { response?: { data?: unknown } }).response?.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object") {
        const message = (data as { message?: unknown }).message;
        if (typeof message === "string") return message;
        if (Array.isArray(message)) return message.join("; ");
    }

    const topMessage = (error as { message?: unknown }).message;
    return typeof topMessage === "string" ? topMessage : "";
}

/**
 * Parse the backend's in-use rejection into its FULL reason list. Returns [] when
 * the error is not a structured in-use rejection (network/unknown) — the caller
 * then falls back to a toast. The list is returned uncapped; the cap is a render
 * concern in DeleteRejectionAlert.
 */
export function parseRejectionReasons(error: unknown): string[] {
    const message = extractMessage(error);
    const idx = message.indexOf(REFS_MARKER);
    if (idx === -1) return [];

    const tail = message
        .slice(idx + REFS_MARKER.length)
        .trim()
        .replace(/\.\s*$/, "");

    return tail
        .split("; ")
        .map((reason) => reason.trim())
        .filter(Boolean);
}

/**
 * True when the target model is the org's ONLY remaining non-managed model —
 * deleting it disconnects BYOK entirely. Managed (env-default) credentials are
 * excluded (they never render and don't count as connected BYOK models).
 */
export function isLastModel(
    config: BYOKConfig | null | undefined,
    modelId: string,
): boolean {
    const models = groupModelsByProvider(config).flatMap((g) => g.models);
    return models.length === 1 && models[0]?.id === modelId;
}

export type DeleteConfirmCopy = {
    title: string;
    description: string;
    confirmText: string;
};

/**
 * Confirm-modal copy for the delete flow. The last-model path uses the distinct
 * "Disconnect BYOK entirely?" copy; the body is the UI-SPEC superset, verified at
 * execute against resolve-task-model.ts's degradation contract (no BYOK →
 * env/managed default, else no model → reviews stop).
 */
export function deleteConfirmCopy(
    isLast: boolean,
    modelName: string,
): DeleteConfirmCopy {
    if (isLast) {
        return {
            title: "Disconnect BYOK entirely?",
            description:
                "This removes your only connected model. Kodus falls back to " +
                "your environment-configured LLM if one exists, or stops running " +
                "reviews until you connect a new model.",
            confirmText: "Disconnect",
        };
    }
    return {
        title: `Remove ${modelName}?`,
        description: "Kodus will stop using this model immediately.",
        confirmText: "Remove",
    };
}

/**
 * Persistent inline rejection Alert: rendered UNDER the model row when a delete is
 * rejected because the model is in use. Lists the first 6 backend references +
 * "…and N more" (the ModelOverridesBanner cap). It does NOT auto-dismiss — the
 * user needs it to stay while they go clear every listed reference. Renders
 * nothing when there are no reasons.
 */
export function DeleteRejectionAlert({
    modelName,
    reasons,
}: {
    modelName: string;
    reasons: string[];
}) {
    if (reasons.length === 0) return null;

    const shown = reasons.slice(0, REASON_CAP);
    const remainder = reasons.length - shown.length;

    return (
        <Alert variant="danger" className="mt-2">
            <AlertTriangleIcon />
            <AlertTitle>
                {`"${modelName}" is in use and can't be deleted`}
            </AlertTitle>
            <AlertDescription>
                <p className="mb-2 text-sm">
                    It's still in use here — reassign or reset these first, then
                    try again:
                </p>
                <ul className="list-disc space-y-0.5 pl-4">
                    {shown.map((reason, i) => (
                        <li
                            key={`${reason}-${i}`}
                            className="text-text-secondary text-xs">
                            {reason}
                        </li>
                    ))}
                    {remainder > 0 && (
                        <li className="text-text-tertiary text-xs">
                            …and {remainder} more
                        </li>
                    )}
                </ul>
            </AlertDescription>
        </Alert>
    );
}

/**
 * Per-model delete flow. `confirmAndDelete` opens the ConfirmModal (copy chosen by
 * isLastModel) and, on confirm, calls deleteBYOK({ modelId }):
 *  - 200        → onDeleted() fires; rejectionReasons stays empty.
 *  - 400 in-use → rejectionReasons holds the FULL backend list (persistent Alert);
 *                 NO toast, so the reason is not swallowed.
 *  - network    → a toast; rejectionReasons stays empty.
 */
export function useDeleteModel({
    config,
    model,
    onDeleted,
}: {
    config: BYOKConfig | null | undefined;
    model: BYOKModelConfig;
    onDeleted?: () => void;
}): { confirmAndDelete: () => void; rejectionReasons: string[] } {
    const [rejectionReasons, setRejectionReasons] = useState<string[]>([]);

    const name = formatModelLabel(model.model);
    const copy = deleteConfirmCopy(isLastModel(config, model.id), name);

    const confirmAndDelete = () => {
        magicModal.show(() => (
            <ConfirmModal
                open
                title={copy.title}
                description={copy.description}
                confirmText={copy.confirmText}
                variant="primary-dark"
                onConfirm={async () => {
                    magicModal.hide();
                    try {
                        await deleteBYOK({ modelId: model.id });
                        setRejectionReasons([]);
                        onDeleted?.();
                    } catch (error) {
                        const reasons = parseRejectionReasons(error);
                        if (reasons.length > 0) {
                            // In-use: surface the full reason list persistently.
                            setRejectionReasons(reasons);
                        } else {
                            // Network/unknown: a toast, unchanged.
                            toast({
                                variant: "danger",
                                title: `Couldn't remove ${name}`,
                            });
                        }
                    }
                }}
                onCancel={() => magicModal.hide()}
            />
        ));
    };

    return { confirmAndDelete, rejectionReasons };
}
