import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
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
 */
export const LockedFeatureOverlay = ({
    title,
    description,
    cta,
    children,
    className,
}: React.PropsWithChildren<{
    title: React.ReactNode;
    description: React.ReactNode;
    cta?: {
        label: string;
        href: string;
        feature: GateFeature;
        plan?: string;
        metadata?: Record<string, unknown>;
    };
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
                    className="flex w-md max-w-full flex-col items-center gap-6 p-10 text-center">
                    <div className="bg-card-lv2 flex size-12 items-center justify-center rounded-full">
                        <LockIcon className="text-primary-light size-5" />
                    </div>

                    <div className="flex flex-col gap-2">
                        <Heading variant="h2">{title}</Heading>
                        <p className="text-text-secondary text-sm">
                            {description}
                        </p>
                    </div>

                    {cta && (
                        <GateCtaLink
                            href={cta.href}
                            label={cta.label}
                            feature={cta.feature}
                            plan={cta.plan}
                            metadata={cta.metadata}
                        />
                    )}
                </Card>
            </div>
        </div>
    );
};
