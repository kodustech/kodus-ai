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
                    <CheckIcon className="text-primary-light mt-0.5 size-4 shrink-0" />
                    <span className="text-text-secondary">{item}</span>
                </li>
            ))}
        </ul>
    </div>
);
