"use client";

import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Switch } from "@components/ui/switch";
import * as RadioGroup from "@radix-ui/react-radio-group";
import type {
    RuntimeMode,
    RuntimeWhoCanAsk,
} from "@services/runtime/contracts";
import {
    RUNTIME_MODE_OPTIONS,
    WHO_CAN_ASK_OPTIONS,
} from "@services/runtime/labels";
import {
    conditionError,
    RULE_FIELDS,
    type DraftRule,
    type RuleField,
    type RuntimeDraft,
} from "@services/runtime/model/rules";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

const MODES: Array<{
    value: RuntimeMode | "auto";
    label: string;
    hint: string;
    soon?: boolean;
}> = [
    ...RUNTIME_MODE_OPTIONS,
    {
        value: "auto",
        label: "Auto",
        hint: "Rules, plus Kody picks risky PRs.",
        soon: true,
    },
];

const SWITCHES = [
    {
        name: "runOnAgentPullRequests",
        label: "Also run on PRs opened by coding agents",
        hint: "Claude Code, Codex, Devin and other bot authors.",
    },
    {
        name: "runOnNewPushes",
        label: "Run again on new pushes",
        hint: "Off: runs once, when the PR opens or a rule first matches.",
    },
] as const;

const RulesEditor = ({
    rules,
    onChange,
    disabled,
}: {
    rules: DraftRule[];
    onChange: (rules: DraftRule[]) => void;
    disabled: boolean;
}) => {
    const setRule = (i: number, rule: DraftRule | null) =>
        onChange(
            rule === null
                ? rules.filter((_, j) => j !== i)
                : rules.map((r, j) => (j === i ? rule : r)),
        );
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
                <span className="text-text-primary text-sm font-medium">
                    Rules
                </span>
                <span className="text-text-secondary text-xs">
                    Checked first and free to evaluate. A PR that matches every
                    condition of any rule runs.
                </span>
            </div>
            {rules.length === 0 && (
                <p className="text-text-secondary text-sm">No rule yet.</p>
            )}
            <ol className="flex flex-col gap-2">
                {rules.map((rule, i) => (
                    <li
                        key={i}
                        aria-label={`Rule ${i + 1}`}
                        className="bg-card-lv2 grid gap-3 rounded-lg p-3 md:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="flex flex-col gap-2">
                            <span className="text-text-tertiary text-xs">
                                When
                            </span>
                            {rule.conditions.map((c, k) => {
                                const error = conditionError(c);
                                const meta = RULE_FIELDS.find(
                                    (f) => f.field === c.field,
                                )!;
                                const setCondition = (
                                    patch: Partial<typeof c> | null,
                                ) =>
                                    setRule(i, {
                                        conditions:
                                            patch === null
                                                ? rule.conditions.filter(
                                                      (_, m) => m !== k,
                                                  )
                                                : rule.conditions.map((x, m) =>
                                                      m === k
                                                          ? { ...x, ...patch }
                                                          : x,
                                                  ),
                                    });
                                return (
                                    <div
                                        key={k}
                                        className="flex flex-wrap items-center gap-2">
                                        {k > 0 && (
                                            <span className="text-text-tertiary w-8 text-xs">
                                                and
                                            </span>
                                        )}
                                        <Select
                                            value={c.field}
                                            disabled={disabled}
                                            onValueChange={(field) =>
                                                setCondition({
                                                    field: field as RuleField,
                                                    value: "",
                                                })
                                            }>
                                            <SelectTrigger
                                                className="w-56"
                                                aria-label={`Rule ${i + 1}, condition ${k + 1}`}>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {RULE_FIELDS.map((f) => (
                                                    <SelectItem
                                                        key={f.field}
                                                        value={f.field}>
                                                        {f.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Input
                                            value={c.value}
                                            disabled={disabled}
                                            placeholder={meta.placeholder}
                                            inputMode={
                                                c.field === "files_changed"
                                                    ? "numeric"
                                                    : undefined
                                            }
                                            aria-label={`${meta.label}, rule ${i + 1}`}
                                            aria-invalid={
                                                !!error && c.value !== ""
                                            }
                                            onChange={(e) =>
                                                setCondition({
                                                    value: e.target.value,
                                                })
                                            }
                                            className={cn(
                                                "min-w-40 flex-1",
                                                c.field !== "files_changed" &&
                                                    "font-mono",
                                            )}
                                        />
                                        <Button
                                            size="icon-sm"
                                            variant="cancel"
                                            disabled={disabled}
                                            aria-label={`Remove condition ${k + 1} of rule ${i + 1}`}
                                            onClick={() =>
                                                rule.conditions.length === 1
                                                    ? setRule(i, null)
                                                    : setCondition(null)
                                            }>
                                            <XIcon />
                                        </Button>
                                    </div>
                                );
                            })}
                            <Button
                                size="xs"
                                variant="helper"
                                className="w-fit"
                                disabled={
                                    disabled || rule.conditions.length >= 5
                                }
                                leftIcon={<PlusIcon />}
                                onClick={() =>
                                    setRule(i, {
                                        conditions: [
                                            ...rule.conditions,
                                            {
                                                field: "changed_paths",
                                                value: "",
                                            },
                                        ],
                                    })
                                }>
                                Add condition
                            </Button>
                        </div>
                        <div className="flex flex-col gap-2 md:items-end">
                            <span className="text-text-tertiary text-xs">
                                Then
                            </span>
                            <span className="text-text-primary text-sm font-medium">
                                Run
                            </span>
                        </div>
                    </li>
                ))}
            </ol>
            <Button
                size="sm"
                variant="helper"
                className="w-fit"
                disabled={disabled || rules.length >= 20}
                leftIcon={<PlusIcon />}
                onClick={() =>
                    onChange([
                        ...rules,
                        { conditions: [{ field: "changed_paths", value: "" }] },
                    ])
                }>
                Add rule
            </Button>
        </div>
    );
};

/** Screen 2, "When it runs": the mode, the rules and the two switches. */
export const WhenItRuns = ({
    draft,
    onChange,
    canEdit,
}: {
    draft: RuntimeDraft;
    onChange: (draft: RuntimeDraft) => void;
    canEdit: boolean;
}) => (
    <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
            <Heading variant="h3">When it runs</Heading>
            <p className="text-text-secondary text-sm">
                Runs next to the review and posts its own comment. It never
                holds up the review.
            </p>
        </div>
        <RadioGroup.Root
            aria-label="When it runs"
            value={draft.mode}
            disabled={!canEdit}
            onValueChange={(value) =>
                onChange({ ...draft, mode: value as RuntimeMode })
            }
            className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {MODES.map((m) => {
                const checked = draft.mode === m.value;
                return (
                    <RadioGroup.Item
                        key={m.value}
                        value={m.value}
                        disabled={!canEdit || m.soon}
                        className={cn(
                            "focus-visible:ring-primary-light flex flex-col gap-1 rounded-xl px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed",
                            checked
                                ? "bg-primary-light/10 ring-primary-light ring-1"
                                : "bg-card-lv1 hover:bg-card-lv2",
                            m.soon && "opacity-60",
                        )}>
                        <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                            {m.label}
                            {m.soon && (
                                <span className="bg-card-lv3 text-text-secondary rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
                                    Soon
                                </span>
                            )}
                        </span>
                        <span className="text-text-secondary text-xs">
                            {m.hint}
                        </span>
                    </RadioGroup.Item>
                );
            })}
        </RadioGroup.Root>

        {draft.mode === "rules" && (
            <div className="bg-card-lv1 rounded-xl p-4">
                <RulesEditor
                    rules={draft.rules}
                    disabled={!canEdit}
                    onChange={(rules) => onChange({ ...draft, rules })}
                />
            </div>
        )}

        {draft.mode !== "off" && (
            <div className="bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y rounded-xl">
                {draft.mode === "rules" &&
                    SWITCHES.map((s) => (
                        <div
                            key={s.name}
                            className="flex items-start gap-4 px-4 py-3">
                            <Switch
                                id={`runtime-${s.name}`}
                                size="sm"
                                className="mt-0.5"
                                checked={draft[s.name]}
                                disabled={!canEdit}
                                onCheckedChange={(v) =>
                                    onChange({ ...draft, [s.name]: v })
                                }
                            />
                            <div className="flex flex-col gap-0.5">
                                <Label
                                    htmlFor={`runtime-${s.name}`}
                                    className="text-text-primary cursor-pointer text-sm font-medium">
                                    {s.label}
                                </Label>
                                <span className="text-text-secondary text-xs">
                                    {s.hint}
                                </span>
                            </div>
                        </div>
                    ))}
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-text-primary text-sm font-medium">
                            Who can ask{" "}
                            <code className="font-mono">@kody runtime</code>
                        </span>
                        <span className="text-text-secondary text-xs">
                            A comment always runs it, whatever the rules say.
                        </span>
                    </div>
                    <Select
                        value={draft.whoCanAsk}
                        disabled={!canEdit}
                        onValueChange={(v) =>
                            onChange({
                                ...draft,
                                whoCanAsk: v as RuntimeWhoCanAsk,
                            })
                        }>
                        <SelectTrigger
                            className="w-64"
                            aria-label="Who can ask @kody runtime">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {WHO_CAN_ASK_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                    {o.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
        )}
    </section>
);
