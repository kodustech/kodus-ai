import type { ReactNode } from "react";
import { Heading } from "@components/ui/heading";

/** A tonal panel with a title: the Runtime screens are built of these. */
export const RuntimeSection = ({
    title,
    description,
    aside,
    children,
    id,
}: {
    title: string;
    description?: ReactNode;
    aside?: ReactNode;
    children: ReactNode;
    id?: string;
}) => (
    <section
        id={id}
        aria-label={title}
        className="bg-card-lv1 flex scroll-mt-24 flex-col gap-4 rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
                <Heading variant="h2" className="text-base">
                    {title}
                </Heading>
                {description && (
                    <p className="text-text-secondary max-w-2xl text-sm">
                        {description}
                    </p>
                )}
            </div>
            {aside}
        </div>
        {children}
    </section>
);

/**
 * The same block without its panel, for a part of a section that already
 * sits on one (the Run page's "What was running"): a small title, no card
 * inside the card.
 */
export const RuntimeSubsection = ({
    title,
    description,
    aside,
    children,
    id,
}: {
    title: string;
    description?: ReactNode;
    aside?: ReactNode;
    children: ReactNode;
    id?: string;
}) => (
    <section
        id={id}
        aria-label={title}
        className="flex scroll-mt-24 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">{title}</Heading>
                {description && (
                    <p className="text-text-secondary max-w-2xl text-sm">
                        {description}
                    </p>
                )}
            </div>
            {aside}
        </div>
        {children}
    </section>
);

/** One number with its label, for the metric strips. */
export const Metric = ({
    label,
    value,
    hint,
}: {
    label: string;
    value: ReactNode;
    hint?: ReactNode;
}) => (
    <div className="bg-card-lv2 flex flex-col gap-1 rounded-lg px-4 py-3">
        <span className="text-text-tertiary text-xs">{label}</span>
        <span className="text-text-primary font-mono text-xl">{value}</span>
        {hint && <span className="text-text-tertiary text-xs">{hint}</span>}
    </div>
);

/** One fact of a header strip (`<dl>` row). */
export const Fact = ({
    label,
    children,
}: {
    label: string;
    children: ReactNode;
}) => (
    <div className="flex flex-col gap-0.5">
        <dt className="text-text-tertiary text-xs">{label}</dt>
        <dd className="text-text-primary text-sm">{children}</dd>
    </div>
);
