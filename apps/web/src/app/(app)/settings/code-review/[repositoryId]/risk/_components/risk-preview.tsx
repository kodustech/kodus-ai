"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { previewPrRisk } from "@services/risk-assessment/fetch";
import type { RiskCriterion } from "@services/risk-assessment/types";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";

export function RiskPreview({
    teamId,
    repositoryId,
    criteria,
    onClose,
}: {
    teamId: string;
    repositoryId: string;
    criteria: RiskCriterion[];
    onClose: () => void;
}) {
    const [repository, setRepository] = useState(
        repositoryId === "global" ? "" : repositoryId,
    );
    const [number, setNumber] = useState("");
    const repositories = useGetSelectedRepositories(teamId);
    const preview = useMutation({ mutationFn: previewPrRisk });
    const result = preview.data?.assessment;
    const prNumber = Number(number);
    return (
        <Sheet
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
                <SheetHeader className="border-card-lv3 border-b py-5">
                    <div className="flex items-center justify-between gap-3">
                        <SheetTitle>Preview on a PR</SheetTitle>
                        <SheetClose asChild>
                            <Button
                                type="button"
                                variant="cancel"
                                size="icon-sm"
                                aria-label="Close preview">
                                <X className="size-4" />
                            </Button>
                        </SheetClose>
                    </div>
                    <SheetDescription>
                        Uses your current criteria. No comments are posted.
                    </SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-5 overflow-y-auto p-6">
                    {repositoryId === "global" && (
                        <FormControl.Root>
                            <FormControl.Label htmlFor="risk-preview-repository">
                                Repository
                            </FormControl.Label>
                            <Select
                                value={repository}
                                onValueChange={(value) => {
                                    setRepository(value);
                                    preview.reset();
                                }}>
                                <SelectTrigger id="risk-preview-repository">
                                    <SelectValue placeholder="Select repository" />
                                </SelectTrigger>
                                <SelectContent>
                                    {repositories.data?.map((repo) => (
                                        <SelectItem
                                            key={repo.id}
                                            value={repo.id}>
                                            {repo.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </FormControl.Root>
                    )}
                    <FormControl.Root>
                        <FormControl.Label htmlFor="risk-preview-number">
                            PR number
                        </FormControl.Label>
                        <Input
                            id="risk-preview-number"
                            type="number"
                            min={1}
                            step={1}
                            value={number}
                            placeholder="123"
                            onChange={(event) => {
                                setNumber(event.target.value);
                                preview.reset();
                            }}
                        />
                    </FormControl.Root>
                    <Button
                        type="button"
                        size="md"
                        variant="primary"
                        loading={preview.isPending}
                        disabled={
                            !repository ||
                            !Number.isSafeInteger(prNumber) ||
                            prNumber < 1
                        }
                        onClick={() =>
                            preview.mutate({
                                teamId,
                                repositoryId: repository,
                                prNumber,
                                criteria,
                            })
                        }>
                        Preview risk
                    </Button>
                    {preview.isError && (
                        <p role="alert" className="text-danger text-sm">
                            Could not load this PR’s risk assessment. Try again.
                        </p>
                    )}
                    {result && (
                        <section
                            aria-live="polite"
                            className="border-card-lv3 flex flex-col gap-3 border-t pt-5">
                            <h3 className="text-sm font-semibold">
                                {result.status === "assessed"
                                    ? result.riskIdentified
                                        ? "Risk found"
                                        : "No risk found"
                                    : result.status === "disabled"
                                      ? "Risk assessment is off"
                                      : "Assessment unavailable"}
                            </h3>
                            {result.status !== "disabled" && (
                                <p className="text-text-secondary text-sm leading-6">
                                    {result.reason}
                                </p>
                            )}
                            {!!preview.data?.files.length && (
                                <details className="text-sm">
                                    <summary className="cursor-pointer">
                                        PR files · {preview.data.files.length}
                                    </summary>
                                    <ul className="mt-3 flex flex-col gap-2">
                                        {preview.data.files.map(
                                            (file, index) => (
                                                <li
                                                    key={`${file.path}-${index}`}
                                                    className="text-text-secondary font-mono text-xs break-all">
                                                    {file.previousPath &&
                                                    file.previousPath !==
                                                        file.path
                                                        ? `${file.previousPath} → `
                                                        : ""}
                                                    {file.path}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                </details>
                            )}
                        </section>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}
