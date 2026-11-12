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
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import type { ApprovalPolicy } from "@services/approval-policies/types";
import { X } from "lucide-react";
import { checkIgnorePattern } from "src/core/utils/ignore-paths/validate-glob-pattern";

import { approvalPolicyScope } from "./approval-policy-scope";
import { FilePatternsField } from "./file-patterns-field";

const conditions = {
    labels: "PR labels",
    authors: "PR author",
    files: "Changed files",
    lines: "Changed lines",
    instruction: "Eligibility instruction",
};
type Condition = keyof typeof conditions;

export function ApprovalPolicyEditor({
    policy,
    existingNames,
    labelsUnavailable,
    teamsUnavailable,
    onApply,
    onClose,
}: {
    policy?: ApprovalPolicy;
    existingNames: string[];
    labelsUnavailable: boolean;
    teamsUnavailable: boolean;
    onApply: (policy: ApprovalPolicy) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<ApprovalPolicy>(
        () => policy ?? { id: crypto.randomUUID(), name: "", enabled: false },
    );
    const [visible, setVisible] = useState<Condition[]>(() => [
        ...(policy?.labels?.length ? ["labels" as const] : []),
        ...(policy?.authors?.length || policy?.authorTeams?.length
            ? ["authors" as const]
            : []),
        ...(policy?.includedFiles?.length || policy?.excludedFiles?.length
            ? ["files" as const]
            : []),
        ...(policy?.maxChangedLines !== undefined ? ["lines" as const] : []),
        ...(policy?.instruction?.trim() ? ["instruction" as const] : []),
    ]);
    const duplicateName = existingNames.some(
        (name) => name.toLowerCase() === draft.name.trim().toLowerCase(),
    );
    const validPaths = [
        ...(draft.includedFiles ?? []),
        ...(draft.excludedFiles ?? []),
        ...(draft.lineCountExcludedFiles ?? []),
    ].every((path) => checkIgnorePattern(path).valid);
    const validLimit =
        draft.maxChangedLines === undefined ||
        (Number.isSafeInteger(draft.maxChangedLines) &&
            draft.maxChangedLines >= 0);
    const update = (patch: Partial<ApprovalPolicy>) =>
        setDraft((current) => ({ ...current, ...patch }));
    const remove = (condition: Condition) => {
        setVisible((current) => current.filter((item) => item !== condition));
        if (condition === "labels") update({ labels: [] });
        if (condition === "authors") update({ authors: [], authorTeams: [] });
        if (condition === "files")
            update({ includedFiles: [], excludedFiles: [] });
        if (condition === "lines")
            update({ maxChangedLines: undefined, lineCountExcludedFiles: [] });
        if (condition === "instruction") update({ instruction: "" });
    };

    return (
        <Sheet
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}>
            <SheetContent
                side="right"
                className="w-full gap-0 py-0 sm:max-w-xl">
                <SheetHeader className="border-card-lv3 shrink-0 border-b py-5">
                    <div className="flex items-center justify-between gap-3">
                        <SheetTitle>
                            {policy ? "Edit policy" : "Add policy"}
                        </SheetTitle>
                        <SheetClose asChild>
                            <Button
                                type="button"
                                variant="cancel"
                                size="icon-sm"
                                aria-label="Close policy editor">
                                <X className="size-4" />
                            </Button>
                        </SheetClose>
                    </div>
                    <SheetDescription>
                        All conditions must match. A clean review is always
                        required.
                    </SheetDescription>
                </SheetHeader>
                <div
                    role="region"
                    aria-label="Policy settings"
                    className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
                    <FormControl.Root>
                        <FormControl.Label htmlFor="approval-policy-name">
                            Name
                        </FormControl.Label>
                        <Input
                            id="approval-policy-name"
                            autoFocus
                            value={draft.name}
                            maxLength={120}
                            onChange={(event) =>
                                update({ name: event.target.value })
                            }
                        />
                        {duplicateName && (
                            <p
                                role="alert"
                                className="text-danger mt-2 text-xs">
                                Choose a distinct policy name.
                            </p>
                        )}
                    </FormControl.Root>
                    <div className="border-card-lv3 bg-card-lv2 rounded-lg border px-4 py-3">
                        <span className="text-text-secondary text-xs">
                            Applies to
                        </span>
                        <p className="text-text-primary mt-1 text-sm break-words">
                            {approvalPolicyScope(draft)}
                        </p>
                    </div>
                    {visible.map((condition) => (
                        <section
                            key={condition}
                            className="border-card-lv3 space-y-4 border-t pt-4">
                            <div className="flex items-center justify-between gap-4">
                                <h3 className="text-sm font-medium">
                                    {conditions[condition]}
                                </h3>
                                <Button
                                    type="button"
                                    variant="cancel"
                                    size="sm"
                                    aria-label={`Remove ${conditions[condition].toLowerCase()} condition`}
                                    onClick={() => remove(condition)}>
                                    <X className="size-4" />
                                </Button>
                            </div>
                            {condition === "labels" && (
                                <FormControl.Root>
                                    <FormControl.Label
                                        className="sr-only"
                                        htmlFor="approval-policy-labels">
                                        PR labels
                                    </FormControl.Label>
                                    <TagInput
                                        id="approval-policy-labels"
                                        tags={draft.labels ?? []}
                                        onTagsChange={(labels) =>
                                            update({ labels })
                                        }
                                        maxTags={50}
                                        placeholder="Add a label"
                                    />
                                    <FormControl.Helper>
                                        Match any listed label.
                                    </FormControl.Helper>
                                    {labelsUnavailable && (
                                        <p className="text-danger text-xs">
                                            Labels are unavailable on this
                                            provider. Remove this condition.
                                        </p>
                                    )}
                                </FormControl.Root>
                            )}
                            {condition === "authors" && (
                                <>
                                    <FormControl.Root>
                                        <FormControl.Label htmlFor="approval-policy-authors">
                                            Usernames or bots
                                        </FormControl.Label>
                                        <TagInput
                                            id="approval-policy-authors"
                                            tags={draft.authors ?? []}
                                            onTagsChange={(authors) =>
                                                update({ authors })
                                            }
                                            maxTags={50}
                                            placeholder="e.g. dependabot[bot]"
                                        />
                                    </FormControl.Root>
                                    {(!teamsUnavailable ||
                                        !!draft.authorTeams?.length) && (
                                        <FormControl.Root>
                                            <FormControl.Label htmlFor="approval-policy-teams">
                                                Teams
                                            </FormControl.Label>
                                            <TagInput
                                                id="approval-policy-teams"
                                                tags={draft.authorTeams ?? []}
                                                onTagsChange={(authorTeams) =>
                                                    update({ authorTeams })
                                                }
                                                maxTags={50}
                                                placeholder="Add a provider team"
                                                disabled={teamsUnavailable}
                                            />
                                            {teamsUnavailable && (
                                                <p className="text-danger text-xs">
                                                    Team conditions are
                                                    unavailable on this
                                                    provider.
                                                </p>
                                            )}
                                        </FormControl.Root>
                                    )}
                                    <p className="text-text-secondary text-xs">
                                        Match the PR opener or a member of a
                                        listed team.
                                    </p>
                                </>
                            )}
                            {condition === "files" && (
                                <>
                                    <FilePatternsField
                                        label="Included files"
                                        purpose="include"
                                        value={draft.includedFiles ?? []}
                                        onChange={(includedFiles) =>
                                            update({ includedFiles })
                                        }
                                        hint="Every changed file must match. Empty means all files."
                                    />
                                    <FilePatternsField
                                        label="Excluded files"
                                        purpose="exclude"
                                        value={draft.excludedFiles ?? []}
                                        onChange={(excludedFiles) =>
                                            update({ excludedFiles })
                                        }
                                        hint="Any match skips this policy."
                                    />
                                </>
                            )}
                            {condition === "lines" && (
                                <>
                                    <FormControl.Root>
                                        <FormControl.Label htmlFor="approval-policy-lines">
                                            Maximum changed lines
                                        </FormControl.Label>
                                        <Input
                                            id="approval-policy-lines"
                                            type="number"
                                            min={0}
                                            step={1}
                                            value={draft.maxChangedLines ?? ""}
                                            onChange={(event) =>
                                                update({
                                                    maxChangedLines:
                                                        event.target.value ===
                                                        ""
                                                            ? undefined
                                                            : Number(
                                                                  event.target
                                                                      .value,
                                                              ),
                                                })
                                            }
                                        />
                                        <FormControl.Helper>
                                            Additions + deletions.
                                        </FormControl.Helper>
                                    </FormControl.Root>
                                    <FilePatternsField
                                        label="Exclude from line count"
                                        purpose="exclude"
                                        value={
                                            draft.lineCountExcludedFiles ?? []
                                        }
                                        onChange={(lineCountExcludedFiles) =>
                                            update({ lineCountExcludedFiles })
                                        }
                                        hint="e.g. yarn.lock. File conditions still apply."
                                    />
                                </>
                            )}
                            {condition === "instruction" && (
                                <FormControl.Root>
                                    <FormControl.Label htmlFor="approval-policy-instruction">
                                        When may Kody approve?
                                    </FormControl.Label>
                                    <Textarea
                                        id="approval-policy-instruction"
                                        value={draft.instruction ?? ""}
                                        maxLength={4000}
                                        className="min-h-28"
                                        placeholder="Only dependency updates that keep the same major version."
                                        onChange={(event) =>
                                            update({
                                                instruction: event.target.value,
                                            })
                                        }
                                    />
                                </FormControl.Root>
                            )}
                        </section>
                    ))}
                    {visible.length < Object.keys(conditions).length && (
                        <Select
                            value=""
                            onValueChange={(condition) =>
                                setVisible((current) => [
                                    ...current,
                                    condition as Condition,
                                ])
                            }>
                            <SelectTrigger aria-label="Add condition">
                                <SelectValue placeholder="Add condition" />
                            </SelectTrigger>
                            <SelectContent>
                                {Object.entries(conditions)
                                    .filter(
                                        ([key]) =>
                                            !visible.includes(key as Condition),
                                    )
                                    .map(([key, label]) => (
                                        <SelectItem
                                            key={key}
                                            value={key}
                                            disabled={
                                                key === "labels" &&
                                                labelsUnavailable
                                            }>
                                            {label}
                                        </SelectItem>
                                    ))}
                            </SelectContent>
                        </Select>
                    )}
                </div>
                <SheetFooter className="border-card-lv3 shrink-0 flex-row justify-end border-t py-4">
                    <Button
                        type="button"
                        variant="cancel"
                        size="md"
                        onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="primary"
                        size="md"
                        disabled={
                            !draft.name.trim() ||
                            duplicateName ||
                            !validPaths ||
                            !validLimit ||
                            (labelsUnavailable && !!draft.labels?.length) ||
                            (teamsUnavailable && !!draft.authorTeams?.length)
                        }
                        onClick={() =>
                            onApply({
                                ...draft,
                                name: draft.name.trim(),
                                instruction: draft.instruction?.trim(),
                            })
                        }>
                        Apply
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
