import { useState } from "react";

import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { useEffectOnce } from "@hooks/use-effect-once";

import type { ImportedKodyRulesCounts } from "@services/kodyRules/fetch";

export type DisableIdeSyncAction = "keep" | "pause" | "delete";

interface Props {
    counts: ImportedKodyRulesCounts;
}

/**
 * Asks the user what should happen to the rules previously auto-imported
 * from IDE files when they turn the auto-sync toggle off. Returns the
 * picked action, or `undefined` if the user cancels.
 *
 * Only rendered when the repository has at least one ACTIVE imported rule
 * — otherwise there's nothing to do and the caller should skip straight to
 * the mutation with `keep`.
 */
export const DisableIdeSyncModal = ({ counts }: Props) => {
    useEffectOnce(() => magicModal.lock());
    const [action, setAction] = useState<DisableIdeSyncAction>("keep");

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Disable IDE rules auto-sync?</DialogTitle>
                    <DialogDescription>
                        You have <strong>{counts.active}</strong>{" "}
                        {counts.active === 1 ? "rule" : "rules"} currently
                        auto-synced from IDE rule files (
                        <code className="text-xs">.cursorrules</code>,{" "}
                        <code className="text-xs">CLAUDE.md</code>, etc.). What
                        should happen to{" "}
                        {counts.active === 1 ? "it" : "them"}?
                    </DialogDescription>
                    {counts.pinned > 0 && (
                        // Pinned rules are skipped by pause/delete — the next
                        // PR-driven sync would re-import them anyway. Telling
                        // the user up front avoids the "I deleted these and
                        // they came back" confusion.
                        <DialogDescription className="text-warning">
                            <strong>{counts.pinned}</strong> of{" "}
                            {counts.active === 1 ? "it" : "them"}{" "}
                            {counts.pinned === 1 ? "is" : "are"} pinned via{" "}
                            <code className="text-xs">@kody-sync</code> and
                            will keep syncing regardless of your choice.
                        </DialogDescription>
                    )}
                </DialogHeader>

                <fieldset className="text-sm flex flex-col gap-3 mt-2">
                    <RadioOption
                        value="keep"
                        selected={action === "keep"}
                        onSelect={setAction}
                        title="Keep them active"
                        subtitle="Recommended"
                        description="Rules stay enforced. They just won't be updated automatically anymore. You can re-enable sync later to resume updates."
                    />
                    <RadioOption
                        value="pause"
                        selected={action === "pause"}
                        onSelect={setAction}
                        title="Pause enforcement"
                        description="Rules stay in your list (status: paused) but stop being applied on new PRs. Resume any time from the rules page."
                    />
                    <RadioOption
                        value="delete"
                        selected={action === "delete"}
                        onSelect={setAction}
                        title="Delete rules"
                        description="Rules are removed from your list (kept in audit history). Re-enabling sync will re-import them from source files."
                    />
                </fieldset>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="secondary"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        onClick={() => magicModal.hide(action)}>
                        Confirm
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

interface RadioOptionProps {
    value: DisableIdeSyncAction;
    selected: boolean;
    onSelect: (value: DisableIdeSyncAction) => void;
    title: string;
    subtitle?: string;
    description: string;
}

const RadioOption = ({
    value,
    selected,
    onSelect,
    title,
    subtitle,
    description,
}: RadioOptionProps) => (
    <label
        className={
            "flex gap-3 p-3 rounded-md border cursor-pointer transition-colors " +
            (selected
                ? "border-primary bg-primary/5"
                : "border-card-lv2 hover:border-card-lv3")
        }>
        <input
            type="radio"
            name="disable-ide-sync-action"
            value={value}
            checked={selected}
            onChange={() => onSelect(value)}
            className="mt-1"
        />
        <div className="flex flex-col gap-1">
            <div className="font-medium flex items-center gap-2">
                {title}
                {subtitle && (
                    <span className="text-xs text-text-secondary font-normal">
                        ({subtitle})
                    </span>
                )}
            </div>
            <div className="text-text-secondary text-xs">{description}</div>
        </div>
    </label>
);
