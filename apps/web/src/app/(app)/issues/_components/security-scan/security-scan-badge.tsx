import { Badge } from "@components/ui/badge";
import { ShieldIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

/** Marks an issue a security scan found (not a code review). */
export const SecurityScanBadge = ({ className }: { className?: string }) => (
    <Badge
        className={cn(
            "bg-info/10 text-info ring-info/64 pointer-events-none h-6 min-h-auto shrink-0 gap-1 rounded-lg px-1.5 text-[10px] leading-px whitespace-nowrap uppercase ring-1 [--icon-size:calc(var(--spacing)*3)]",
            className,
        )}
        leftIcon={<ShieldIcon />}>
        Security scan
    </Badge>
);
