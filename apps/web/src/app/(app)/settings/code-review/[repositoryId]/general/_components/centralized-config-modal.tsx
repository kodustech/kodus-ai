"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Switch } from "@components/ui/switch";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { PARAMETERS_PATHS } from "@services/parameters";
import {
    centralizedConfigDownload,
    centralizedConfigInit,
    centralizedConfigSync,
    createOrUpdateParameter,
} from "@services/parameters/fetch";
import {
    ParametersConfigKey,
    type CentralizedConfigValue,
} from "@services/parameters/types";
import {
    AlertTriangleIcon,
    CheckCircle2,
    ExternalLink,
    XCircle,
} from "lucide-react";

// --- Types & Helpers ---

type CentralizedConfigModalProps = {
    teamId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    centralizedConfig: CentralizedConfigValue;
    onSaved: () => Promise<unknown>;
};

type ActionStatus = {
    type: "success" | "error" | "warning" | null;
    title?: string;
    message?: string;
    prUrl?: string;
};

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
        if ("error" in error) return String((error as any).error);
        if ("message" in error) return String((error as any).message);
    }
    return "An unexpected error occurred.";
};

// --- Sub-components ---

const StatusMessage = ({ status }: { status: ActionStatus }) => {
    if (!status.type) return null;

    const variants = {
        success: {
            variant: "success" as const,
            icon: <CheckCircle2 className="h-4 w-4" />,
        },
        error: {
            variant: "danger" as const,
            icon: <XCircle className="h-4 w-4" />,
        },
        warning: {
            variant: "warning" as const,
            icon: <AlertTriangleIcon className="h-4 w-4" />,
        },
    };

    const config = variants[status.type];

    return (
        <Alert variant={config.variant} className="mt-4">
            {config.icon}
            <div className="ml-2">
                <AlertTitle className="font-bold">{status.title}</AlertTitle>
                <AlertDescription className="mt-1">
                    {status.message}
                    {status.prUrl && (
                        <div className="mt-3">
                            <a
                                href={status.prUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white/20">
                                <ExternalLink className="h-3 w-3" />
                                View Pull Request
                            </a>
                        </div>
                    )}
                </AlertDescription>
            </div>
        </Alert>
    );
};

// --- Main Component ---

export const CentralizedConfigModal = ({
    teamId,
    open,
    onOpenChange,
    centralizedConfig,
    onSaved,
}: CentralizedConfigModalProps) => {
    const { resetQueries, generateQueryKey } = useReactQueryInvalidateQueries();
    const router = useRouter();

    // UI State
    const [enabled, setEnabled] = useState(centralizedConfig.enabled);
    const [persistedEnabled, setPersistedEnabled] = useState(
        centralizedConfig.enabled,
    );
    const [selectedRepoId, setSelectedRepoId] = useState(
        centralizedConfig.repository?.id ?? "",
    );
    const [syncOption, setSyncOption] = useState<"manual" | "pr">("pr");
    const [status, setStatus] = useState<ActionStatus>({ type: null });

    // Loading State
    const [loadingAction, setLoadingAction] = useState<
        "saving" | "syncing" | "downloading" | null
    >(null);

    const { data: repositories = [], isLoading: isLoadingRepos } =
        useGetSelectedRepositories(teamId);

    // Initial reset when modal opens (Prevents status from disappearing on data refresh)
    const hasInitialized = useRef(false);
    useEffect(() => {
        if (open && !hasInitialized.current) {
            setEnabled(centralizedConfig.enabled);
            setPersistedEnabled(centralizedConfig.enabled);
            setSelectedRepoId(centralizedConfig.repository?.id ?? "");
            setSyncOption("pr");
            setStatus({ type: null });
            hasInitialized.current = true;
        } else if (!open) {
            hasInitialized.current = false;
        }
    }, [open, centralizedConfig.enabled, centralizedConfig.repository?.id]);

    // Handle internal toggle change (resets error status to keep UI clean)
    const handleToggleChange = (val: boolean) => {
        setEnabled(val);
        if (status.type === "error") setStatus({ type: null });
    };

    const hasChanges = useMemo(
        () =>
            enabled !== centralizedConfig.enabled ||
            (enabled &&
                (centralizedConfig.repository?.id !== selectedRepoId ||
                    syncOption !== "pr")),
        [enabled, selectedRepoId, syncOption, centralizedConfig],
    );

    const invalidateParams = async () => {
        const keys = [
            ParametersConfigKey.CENTRALIZED_CONFIG,
            ParametersConfigKey.CODE_REVIEW_CONFIG,
        ].map((key) =>
            generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                params: { key, teamId },
            }),
        );

        keys.push(
            generateQueryKey(PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER, {
                params: { teamId },
            }),
        );
        await Promise.all(keys.map((queryKey) => resetQueries({ queryKey })));
        router.refresh();
        await onSaved();
    };

    const handleSave = async () => {
        if (enabled && !selectedRepoId) {
            setStatus({
                type: "error",
                title: "Selection Required",
                message: "Please select a repository.",
            });
            return;
        }

        setLoadingAction("saving");
        setStatus({ type: null });

        try {
            let result: any;
            if (!enabled && centralizedConfig.enabled) {
                result = await createOrUpdateParameter(
                    ParametersConfigKey.CENTRALIZED_CONFIG,
                    { enabled: false, repository: null },
                    teamId,
                );
                setPersistedEnabled(false);
            } else {
                const selectedRepo = repositories.find(
                    (r) => r.id === selectedRepoId,
                );
                result = await centralizedConfigInit({
                    teamId,
                    repository: {
                        id: selectedRepo?.id ?? selectedRepoId,
                        name: selectedRepo?.name ?? "",
                    },
                    syncOption,
                });
                if (result.success) setPersistedEnabled(true);
            }

            if (result?.error || result?.success === false)
                throw new Error(result.error || result.message);

            // We update status FIRST so it's captured before the parent might re-render
            setStatus({
                type: "success",
                title: "Settings Saved",
                message:
                    result.message ||
                    "Centralized configuration updated successfully.",
                prUrl: result.prUrl,
            });

            await invalidateParams();
        } catch (err) {
            setStatus({
                type: "error",
                title: "Save Failed",
                message: getErrorMessage(err),
            });
        } finally {
            setLoadingAction(null);
        }
    };

    const handleSync = async () => {
        setLoadingAction("syncing");
        setStatus({ type: null });
        try {
            const res = await centralizedConfigSync(teamId);
            if (res?.error) throw new Error(res.error);
            setStatus({
                type: "success",
                title: "Sync Complete",
                message: res?.message || "Settings synchronized.",
            });
            await invalidateParams();
        } catch (err) {
            setStatus({
                type: "error",
                title: "Sync Failed",
                message: getErrorMessage(err),
            });
        } finally {
            setLoadingAction(null);
        }
    };

    const handleDownload = async () => {
        setLoadingAction("downloading");
        try {
            const blob = await centralizedConfigDownload(teamId);
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "centralized-config.zip";
            a.click();
            window.URL.revokeObjectURL(url);
        } catch (err) {
            setStatus({
                type: "error",
                title: "Download Failed",
                message: getErrorMessage(err),
            });
        } finally {
            setLoadingAction(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Centralized Config</DialogTitle>
                    <DialogDescription>
                        Manage your repository settings authority.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Toggle */}
                    <div className="bg-card-lv2 border-card-lv3 flex items-center justify-between rounded-xl border p-4">
                        <div className="space-y-1">
                            <p className="text-sm font-medium">
                                Enable centralized config
                            </p>
                            <p className="text-text-secondary text-xs">
                                Automate settings via Git.
                            </p>
                        </div>
                        <Switch
                            checked={enabled}
                            onCheckedChange={handleToggleChange}
                            disabled={loadingAction === "saving"}
                        />
                    </div>

                    <Alert variant="info">
                        <AlertTitle className="text-balance">
                            Tip: easier with CLI
                        </AlertTitle>
                        <AlertDescription className="text-pretty">
                            Managing centralized config is easier with our CLI.
                            See the setup guide in our docs.
                            <a
                                href="https://docs.kodus.io/how_to_use/en/code_review/configs/centralized_config#cli-dedicated-section"
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary-light ml-1 inline-flex items-center gap-1 underline">
                                Open docs
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </AlertDescription>
                    </Alert>

                    {enabled && (
                        <div className="animate-in fade-in slide-in-from-top-2 space-y-4 duration-200">
                            {/* Sync Options (Only for new setups) */}
                            {!persistedEnabled && (
                                <div className="bg-card-lv2 border-card-lv3 space-y-3 rounded-xl border p-4">
                                    <p className="text-sm font-medium">
                                        Initial Sync Method
                                    </p>
                                    <Select
                                        value={syncOption}
                                        onValueChange={(v) =>
                                            setSyncOption(v as any)
                                        }>
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="pr">
                                                Automatic (Create PR now)
                                            </SelectItem>
                                            <SelectItem value="manual">
                                                Manual (Sync later)
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-text-secondary text-xs">
                                        PR mode will initialize your repo with
                                        current settings.
                                    </p>
                                </div>
                            )}

                            {/* Repo Selection */}
                            <div className="bg-card-lv2 border-card-lv3 space-y-2 rounded-xl border p-4 text-sm">
                                <p className="font-medium">
                                    Selected repository
                                </p>
                                {persistedEnabled ? (
                                    <p className="text-primary font-semibold">
                                        {repositories.find(
                                            (r) => r.id === selectedRepoId,
                                        )?.name || "Connected Repository"}
                                    </p>
                                ) : (
                                    <Select
                                        value={selectedRepoId}
                                        onValueChange={setSelectedRepoId}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Choose repository" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {repositories.map((repo) => (
                                                <SelectItem
                                                    key={repo.id}
                                                    value={repo.id}>
                                                    {repo.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                        </div>
                    )}

                    <StatusMessage status={status} />
                </div>

                <DialogFooter className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                        size="sm"
                        variant="cancel"
                        onClick={() => onOpenChange(false)}
                        disabled={!!loadingAction}
                        className="sm:mr-auto">
                        Close
                    </Button>
                    <Button
                        size="sm"
                        variant="helper"
                        onClick={handleDownload}
                        loading={loadingAction === "downloading"}
                        disabled={!!loadingAction || repositories.length === 0}>
                        Download
                    </Button>
                    {persistedEnabled && (
                        <Button
                            size="sm"
                            variant="helper"
                            onClick={handleSync}
                            loading={loadingAction === "syncing"}
                            disabled={!!loadingAction || !enabled}>
                            Sync Now
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="primary"
                        onClick={handleSave}
                        loading={loadingAction === "saving"}
                        disabled={!!loadingAction || !hasChanges}>
                        {enabled && !persistedEnabled
                            ? "Initialize"
                            : "Save Changes"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
