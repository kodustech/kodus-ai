import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { LockIcon } from "lucide-react";
import { cn } from "src/core/utils/components";
import type { GateFeature } from "src/core/utils/gate-hit";

import { GateCtaLink } from "./gate-cta-link";

/**
 * Renders the real (or mocked) screen behind a blur with a centered
 * unlock card on top, instead of hiding gated features or redirecting
 * away. Children must never carry real data the viewer isn't entitled
 * to see — the blur is purely visual and trivially removable via
 * devtools; pass a static preview when the viewer lacks access.
 *
 * The card is where a gate earns its click, so it takes more than a title:
 * `details` names what is actually locked (ideally against something the
 * viewer already has), and `altCta` covers the case where upgrading isn't
 * yet the right next step — a workspace with nothing to measure needs a
 * repository before it needs a plan. When `altCta` is given it becomes the
 * primary button and the plan CTA steps down to a quiet link, so the card
 * still only ever asks for one thing.
 */
export const LockedFeatureOverlay = ({
    title,
    description,
    details,
    cta,
    altCta,
    children,
    className,
}: React.PropsWithChildren<{
    title: React.ReactNode;
    description: React.ReactNode;
    details?: React.ReactNode;
    cta?: {
        label: string;
        href: string;
        feature: GateFeature;
        plan?: string;
        metadata?: Record<string, unknown>;
    };
    altCta?: { label: string; href: string };
    className?: string;
}>) => {
    return (
        <div className={cn("relative flex-1 overflow-hidden", className)}>
            <div
                aria-hidden
                className="pointer-events-none h-full select-none opacity-60 blur-[6px]">
                {children}
            </div>

            <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
                <Card
                    color="lv1"
                    className="flex w-lg max-w-full flex-col items-center gap-6 p-8 text-center sm:p-10">
                    <div className="bg-card-lv2 flex size-12 items-center justify-center rounded-full">
                        <LockIcon className="text-primary-light size-5" />
                    </div>

                    <div className="flex flex-col gap-2">
                        <Heading variant="h2">{title}</Heading>
                        <p className="text-text-secondary text-sm">
                            {description}
                        </p>
                    </div>

                    {details}

                    {(cta || altCta) && (
                        <div className="flex flex-col items-center gap-3">
                            {altCta ? (
                                <Link href={altCta.href}>
                                    <Button
                                        decorative
                                        size="md"
                                        variant="primary">
                                        {altCta.label}
                                    </Button>
                                </Link>
                            ) : (
                                cta && (
                                    <GateCtaLink
                                        href={cta.href}
                                        label={cta.label}
                                        feature={cta.feature}
                                        plan={cta.plan}
                                        metadata={cta.metadata}
                                    />
                                )
                            )}

                            {altCta && cta && (
                                <GateCtaLink
                                    href={cta.href}
                                    label={cta.label}
                                    feature={cta.feature}
                                    plan={cta.plan}
                                    metadata={cta.metadata}
                                    size="sm"
                                    variant="cancel"
                                />
                            )}
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
};
