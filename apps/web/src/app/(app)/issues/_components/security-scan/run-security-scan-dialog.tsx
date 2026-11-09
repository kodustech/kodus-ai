"use client";

import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    securityScansPath,
    startSecurityScan,
} from "@services/security-scans/fetch";
import { useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { ShieldIcon, XCircleIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { extractRejectionMessage } from "src/core/utils/extract-error-message";
import { hasPermission } from "src/core/utils/permission-map";

import { formatTokenCount, isNoKnownPriceMessage } from "./format";

const DEFAULT_MAX_USD = "20";
const DEFAULT_MAX_TOKENS = "2000000";

type LimitBy = "usd" | "tokens";

/**
 * "Run deep scan" button and its dialog. Starting a scan is its own
 * permission, granted per repository, so the button hides without it and the
 * picker lists only the repositories it covers.
 */
export const RunSecurityScanButton = () => {
    const canStartScan = usePermission(
        Action.Create,
        ResourceType.SecurityScan,
    );
    const [open, setOpen] = useState(false);

    if (!canStartScan) return null;

    return (
        <>
            <Button
                size="sm"
                variant="primary"
                leftIcon={<ShieldIcon />}
                onClick={() => setOpen(true)}>
                Run deep scan
            </Button>

            {open && <RunSecurityScanDialog onClose={() => setOpen(false)} />}
        </>
    );
};

const RunSecurityScanDialog = ({ onClose }: { onClose: () => void }) => {
    const queryClient = useQueryClient();
    const { teamId } = useSelectedTeamId();
    const { organizationId } = useAuth();
    const permissions = usePermissions();

    const { data: allRepositories, isLoading: isLoadingRepositories } =
        useGetSelectedRepositories(teamId);

    const repositories = useMemo(() => {
        if (!organizationId || !Array.isArray(allRepositories)) return [];

        return allRepositories.filter((repo) =>
            hasPermission({
                permissions,
                organizationId,
                action: Action.Create,
                resource: ResourceType.SecurityScan,
                repoId: String(repo.id),
            }),
        );
    }, [allRepositories, organizationId, permissions]);

    const [repositoryId, setRepositoryId] = useState("");
    const [limitBy, setLimitBy] = useState<LimitBy>("usd");
    const [maxUsd, setMaxUsd] = useState(DEFAULT_MAX_USD);
    const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
    const [apiError, setApiError] = useState<string>();
    const [submitting, setSubmitting] = useState(false);

    const usdValue = Number(maxUsd);
    const tokensValue = Number(maxTokens);
    const limitError =
        limitBy === "usd"
            ? !maxUsd.trim() || !Number.isFinite(usdValue) || usdValue < 1
                ? "Enter at least $1."
                : undefined
            : !maxTokens.trim() ||
                !Number.isInteger(tokensValue) ||
                tokensValue < 1
              ? "Enter a whole number of tokens."
              : undefined;

    const canSubmit = !!teamId && !!repositoryId && !limitError && !submitting;

    const submit = async () => {
        if (!canSubmit) return;

        setSubmitting(true);
        setApiError(undefined);

        try {
            await startSecurityScan({
                teamId,
                repositoryId,
                ...(limitBy === "usd"
                    ? { maxUsd: usdValue }
                    : { maxTokens: tokensValue }),
            });

            await queryClient.invalidateQueries({
                queryKey: [securityScansPath()],
            });

            toast({
                variant: "success",
                title: "Security scan started",
                description:
                    "Findings will show up here as Issues with the label Security.",
            });

            onClose();
        } catch (error) {
            const message =
                extractRejectionMessage(error) ??
                "We couldn't start the scan. Try again.";

            // The org's model has no known price: a USD cap can't be enforced,
            // so move the form to tokens and keep the API's explanation.
            if (
                isAxiosError(error) &&
                error.response?.status === 400 &&
                isNoKnownPriceMessage(message)
            ) {
                setLimitBy("tokens");
            }

            setApiError(message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        Run deep scan <Badge>Beta</Badge>
                    </DialogTitle>
                    <DialogDescription>
                        Kody reads the repository&apos;s default branch with
                        your organization&apos;s own model and stops at the
                        limit you set. Findings show up as Issues with the label
                        Security. In beta: check each finding before acting on
                        it.
                    </DialogDescription>
                </DialogHeader>

                <form
                    id="run-security-scan"
                    className="flex flex-col gap-5"
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        submit();
                    }}>
                    <FormControl.Root>
                        <FormControl.Label htmlFor="security-scan-repository">
                            Repository
                        </FormControl.Label>
                        <FormControl.Input>
                            <Select
                                value={repositoryId}
                                disabled={submitting}
                                onValueChange={(v) => {
                                    setRepositoryId(v);
                                    setApiError(undefined);
                                }}>
                                <SelectTrigger
                                    id="security-scan-repository"
                                    size="md"
                                    loading={isLoadingRepositories}>
                                    <SelectValue placeholder="Choose a repository" />
                                </SelectTrigger>
                                <SelectContent>
                                    {repositories.map((repo) => (
                                        <SelectItem
                                            key={repo.id}
                                            value={String(repo.id)}>
                                            <span className="text-text-secondary">
                                                {repo.organizationName}/
                                            </span>
                                            {repo.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </FormControl.Input>
                        {!isLoadingRepositories &&
                            repositories.length === 0 && (
                                <FormControl.Helper>
                                    No repositories you can scan in this team.
                                </FormControl.Helper>
                            )}
                    </FormControl.Root>

                    {limitBy === "usd" ? (
                        <FormControl.Root>
                            <FormControl.Label htmlFor="security-scan-max-usd">
                                Spend limit (USD)
                            </FormControl.Label>
                            <FormControl.Input>
                                <Input
                                    id="security-scan-max-usd"
                                    size="md"
                                    type="number"
                                    inputMode="decimal"
                                    min={1}
                                    step="any"
                                    value={maxUsd}
                                    disabled={submitting}
                                    error={limitError}
                                    leftIcon={
                                        <span className="text-text-secondary text-sm">
                                            $
                                        </span>
                                    }
                                    onChange={(ev) =>
                                        setMaxUsd(ev.target.value)
                                    }
                                />
                            </FormControl.Input>
                            <FormControl.Error>{limitError}</FormControl.Error>
                            <LimitToggle
                                label="Limit by tokens instead"
                                onClick={() => setLimitBy("tokens")}
                            />
                        </FormControl.Root>
                    ) : (
                        <FormControl.Root>
                            <FormControl.Label htmlFor="security-scan-max-tokens">
                                Token limit
                            </FormControl.Label>
                            <FormControl.Input>
                                <Input
                                    id="security-scan-max-tokens"
                                    size="md"
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    step={1}
                                    value={maxTokens}
                                    disabled={submitting}
                                    error={limitError}
                                    onChange={(ev) =>
                                        setMaxTokens(ev.target.value)
                                    }
                                />
                            </FormControl.Input>
                            {limitError ? (
                                <FormControl.Error>
                                    {limitError}
                                </FormControl.Error>
                            ) : (
                                <FormControl.Helper>
                                    {formatTokenCount(tokensValue)} input and
                                    output tokens.
                                </FormControl.Helper>
                            )}
                            <LimitToggle
                                label="Limit by USD instead"
                                onClick={() => setLimitBy("usd")}
                            />
                        </FormControl.Root>
                    )}

                    {apiError && (
                        <Alert variant="danger">
                            <XCircleIcon />
                            <AlertDescription>{apiError}</AlertDescription>
                        </Alert>
                    )}
                </form>

                <DialogFooter>
                    <Button size="md" variant="cancel" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        type="submit"
                        form="run-security-scan"
                        leftIcon={<ShieldIcon />}
                        loading={submitting}
                        disabled={!canSubmit}>
                        Start scan
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

const LimitToggle = ({
    label,
    onClick,
}: {
    label: string;
    onClick: () => void;
}) => (
    <button
        type="button"
        onClick={onClick}
        className="text-primary-light mt-2 w-fit text-xs underline-offset-2 hover:underline">
        {label}
    </button>
);
