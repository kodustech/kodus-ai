"use client";

import { useState } from "react";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { Link } from "@components/ui/link";
import { RadioGroup } from "@components/ui/radio-group";
import { Skeleton } from "@components/ui/skeleton";
import { useReadTools, useTaskSources } from "@services/business-logic/hooks";
import { Controller, useFormContext, useWatch } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

const AUTO = "auto";

/** The server drops longer or backtracking-prone patterns. */
const MAX_PATTERN = 200;

/** The ids a pattern finds in a sample, as Kody reads them: the first group, or the whole match. */
const previewIds = (pattern: string, sample: string): string[] | "invalid" => {
    if (!pattern.trim()) return [];
    if (pattern.length > MAX_PATTERN) return "invalid";
    try {
        return [...sample.matchAll(new RegExp(pattern, "g"))]
            .map((m) => (m[1] ?? m[0]).trim())
            .filter(Boolean);
    } catch {
        return "invalid";
    }
};

/**
 * Where tasks are read from (UC-01 to UC-04). `auto` reads every tracker
 * Kody recognizes; picking one plugin reads only that one, and a custom
 * plugin also needs the tool that reads one task by its id.
 */
export const TaskSource = ({
    teamId,
    canEdit,
}: {
    teamId: string;
    canEdit: boolean;
}) => {
    const form = useFormContext<CodeReviewFormType>();
    const { data: sources, isLoading } = useTaskSources(teamId);
    const selected =
        (useWatch({
            control: form.control,
            name: "businessLogic.taskSource.value" as never,
        }) as string | undefined) ?? AUTO;
    const selectedSource = sources?.find((s) => s.integrationId === selected);
    const isCustom = selectedSource?.kind === "custom";
    const pattern =
        (useWatch({
            control: form.control,
            name: "businessLogic.taskIdPattern.value" as never,
        }) as string | undefined) ?? "";
    const [sample, setSample] = useState("");
    const preview = previewIds(pattern, sample);
    const { data: tools, isLoading: toolsLoading } = useReadTools(
        teamId,
        isCustom ? selected : undefined,
    );

    return (
        <section
            className="flex flex-col gap-3"
            data-field-name="businessLogic.taskSource">
            <div className="flex items-center gap-2">
                <Heading variant="h3">Task source</Heading>
                <OverrideIndicatorForm fieldName="businessLogic.taskSource" />
            </div>
            <p className="text-text-secondary text-sm">
                Where Kody reads the task a pull request references. A
                repository can pick a different source than the global default.
            </p>

            {isLoading ? (
                <Skeleton className="h-24 w-full rounded-xl" />
            ) : !sources?.length ? (
                <Card color="lv1" className="px-5 py-4 text-sm">
                    No task tracker is connected.{" "}
                    <Link href="/settings/plugins">Connect one in Plugins</Link>{" "}
                    (Linear, Jira, Notion, Git Issues, or a custom plugin).
                </Card>
            ) : (
                <Controller
                    name={"businessLogic.taskSource.value" as never}
                    control={form.control}
                    render={({ field }) => (
                        <RadioGroup.Root
                            value={(field.value as string) ?? AUTO}
                            onValueChange={(value) => {
                                field.onChange(value);
                                // The picked tool belongs to the old source.
                                // Clear it only when there is one: writing ""
                                // over an unset field left the layout's
                                // unsaved-changes guard stuck on.
                                const tool =
                                    "businessLogic.taskSourceTool.value" as never;
                                if (form.getValues(tool)) {
                                    form.setValue(tool, "" as never, {
                                        shouldDirty: true,
                                    });
                                }
                            }}
                            disabled={!canEdit || field.disabled}
                            className="gap-2">
                            <Label className="bg-card-lv1 flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3">
                                <RadioGroup.Item
                                    value={AUTO}
                                    className="mt-0.5"
                                />
                                <span className="flex flex-col">
                                    <span className="text-text-primary text-sm font-medium">
                                        Every connected tracker
                                    </span>
                                    <span className="text-text-secondary text-xs">
                                        {sources
                                            .filter((s) => s.kind === "managed")
                                            .map((s) => s.name)
                                            .join(", ") ||
                                            "None recognized yet"}
                                        . Custom plugins are only used when
                                        picked below.
                                    </span>
                                </span>
                            </Label>
                            {sources.map((source) => (
                                <Label
                                    key={source.integrationId}
                                    className="bg-card-lv1 flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3">
                                    <RadioGroup.Item
                                        value={source.integrationId}
                                        className="mt-0.5"
                                    />
                                    <span className="flex flex-col">
                                        <span className="text-text-primary text-sm font-medium">
                                            {source.name}
                                            {source.kind === "custom" && (
                                                <span className="bg-card-lv3 text-text-secondary ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                                                    Custom plugin
                                                </span>
                                            )}
                                        </span>
                                        <span className="text-text-secondary text-xs">
                                            Only this tracker
                                        </span>
                                    </span>
                                </Label>
                            ))}
                        </RadioGroup.Root>
                    )}
                />
            )}

            {isCustom && (
                <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
                    <span className="text-text-primary text-sm font-medium">
                        Which tool reads a task by its id?
                    </span>
                    {toolsLoading ? (
                        <Skeleton className="h-10 w-full" />
                    ) : !tools?.length ? (
                        <p className="text-warning text-sm">
                            {selectedSource?.name} has no tool that reads one
                            item by its id. Kody can&apos;t read tasks from it.
                        </p>
                    ) : (
                        <Controller
                            name={"businessLogic.taskSourceTool.value" as never}
                            control={form.control}
                            render={({ field }) => (
                                <RadioGroup.Root
                                    value={(field.value as string) || ""}
                                    onValueChange={field.onChange}
                                    disabled={!canEdit || field.disabled}
                                    className="gap-2">
                                    {tools.map((tool) => (
                                        <Label
                                            key={tool.name}
                                            className="flex cursor-pointer items-start gap-3">
                                            <RadioGroup.Item
                                                value={tool.name}
                                                className="mt-0.5"
                                            />
                                            <span className="flex flex-col">
                                                <code className="text-text-primary text-sm">
                                                    {tool.name}
                                                </code>
                                                <span className="text-text-secondary text-xs">
                                                    {tool.recommended
                                                        ? "Recommended · reads one item by id"
                                                        : "Read-only"}
                                                    {tool.description
                                                        ? ` · ${tool.description}`
                                                        : ""}
                                                </span>
                                            </span>
                                        </Label>
                                    ))}
                                </RadioGroup.Root>
                            )}
                        />
                    )}
                    <p className="text-text-secondary text-xs">
                        Only tools that read one task by its id are listed.
                        Search and list tools can return a different task, and
                        tools that write are never used. Check it with Try it
                        below.
                    </p>

                    <div className="border-card-lv3/60 flex flex-col gap-2 border-t pt-3">
                        <span className="text-text-primary text-sm font-medium">
                            How your task ids look{" "}
                            <span className="text-text-secondary font-normal">
                                (optional)
                            </span>
                        </span>
                        <p className="text-text-secondary text-xs">
                            Kody already finds keys like SAA-96, AB#8, #12 and
                            tracker links. For another shape, write a regular
                            expression; its first group, when it has one, is the
                            id. For example <code>sc-(\d+)</code> reads 123 from
                            the branch <code>nina/sc-123-gift-cards</code>.
                        </p>
                        <Controller
                            name={"businessLogic.taskIdPattern.value" as never}
                            control={form.control}
                            render={({ field }) => (
                                <Input
                                    placeholder="e.g. sc-(\d+)"
                                    value={(field.value as string) ?? ""}
                                    onChange={field.onChange}
                                    maxLength={MAX_PATTERN}
                                    disabled={!canEdit || field.disabled}
                                />
                            )}
                        />
                        {pattern.trim() && (
                            <>
                                <Input
                                    placeholder="Paste a title, branch or description to preview"
                                    value={sample}
                                    onChange={(e) => setSample(e.target.value)}
                                />
                                <span
                                    className={
                                        preview === "invalid"
                                            ? "text-danger text-xs"
                                            : "text-text-secondary text-xs"
                                    }>
                                    {preview === "invalid"
                                        ? "Not a valid regular expression."
                                        : !sample.trim()
                                          ? "Kody drops a pattern that could take too long to run, like (a+)+."
                                          : preview.length
                                            ? `Reads: ${preview.join(", ")}`
                                            : "No id in this text."}
                                </span>
                            </>
                        )}
                    </div>
                </Card>
            )}
        </section>
    );
};
