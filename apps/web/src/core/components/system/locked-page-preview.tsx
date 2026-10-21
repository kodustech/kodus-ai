import { Page } from "@components/ui/page";
import { cn } from "src/core/utils/components";

// Static stand-in for a gated screen, rendered behind LockedFeatureOverlay's
// blur. Only shapes, no data: the blur is cosmetic and the viewer must not be
// able to read anything they are not entitled to.
export const LockedPagePreview = ({
    title,
    rows = 3,
    className,
}: {
    title: string;
    rows?: number;
    className?: string;
}) => (
    <Page.Root className={cn("pointer-events-none", className)}>
        <Page.Header>
            <Page.Title>{title}</Page.Title>
            <div className="ml-auto flex items-center gap-2" aria-hidden>
                <div className="bg-card-lv2 h-9 w-32 rounded-lg" />
                <div className="bg-primary/40 h-9 w-28 rounded-lg" />
            </div>
        </Page.Header>
        <Page.Content>
            {Array.from({ length: rows }).map((_, i) => (
                <div
                    key={i}
                    className="border-card-lv3/60 bg-card-lv1 flex items-start justify-between gap-8 rounded-xl border p-6"
                    aria-hidden>
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                        <div className="bg-card-lv3 h-4 w-48 rounded" />
                        <div className="bg-card-lv2 h-3 w-11/12 rounded" />
                        <div className="bg-card-lv2 h-3 w-2/3 rounded" />
                        <div className="bg-card-lv2 mt-2 h-10 w-full rounded-lg" />
                    </div>
                    <div className="bg-card-lv3 h-6 w-11 shrink-0 rounded-full" />
                </div>
            ))}
        </Page.Content>
    </Page.Root>
);
