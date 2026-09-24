/* Hallmark · component: unlock list (locked-feature card) · genre: modern-minimal · theme: system-tokens (text-*, card-lv*)
 * states: static — no interactive element; the card's CTA carries every state
 * one lamp: pass — marks are text-tertiary so the card's only amber region is its CTA
 * honest: pass (46) — every item maps to something the unlocked screen renders
 * contrast: pass (40–41) · tokens: pass (48)
 * pre-emit critique: P4 H4 E4 S4 R5 V3
 */
import { CheckIcon } from "lucide-react";

/**
 * The "what this unlocks" list inside a LockedFeatureOverlay card.
 *
 * Every item must map to something the unlocked screen actually does — a
 * locked screen that promises more than the real one buys a click and loses
 * the customer on the next screen.
 */
export const LockedFeatureUnlocks = ({
    items,
    lead,
}: {
    items: string[];
    /** Optional line above the list, e.g. the workspace's own numbers. */
    lead?: React.ReactNode;
}) => (
    <div className="flex w-full flex-col gap-4">
        {lead}

        <ul className="flex flex-col gap-2 text-left">
            {items.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                    <span className="text-text-secondary">{item}</span>
                </li>
            ))}
        </ul>
    </div>
);
