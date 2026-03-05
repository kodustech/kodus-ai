import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    BrainIcon,
    HelpCircleIcon,
    LayersIcon,
} from "lucide-react";

function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return `${(num / 1_000_000).toFixed(2)}M`;
    }
    if (num >= 1_000) {
        return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toLocaleString();
}

// Tailwind JIT requires full class names - cannot use string interpolation
const colorStyles = {
    primary: {
        bg: "bg-primary-light",
        bgDark: "bg-primary-dark",
        text: "text-primary-light",
    },
    secondary: {
        bg: "bg-secondary-light",
        bgDark: "bg-secondary-dark",
        text: "text-secondary-light",
    },
    tertiary: {
        bg: "bg-tertiary-light",
        bgDark: "bg-tertiary-dark",
        text: "text-tertiary-light",
    },
} as const;

export const SummaryCards = ({
    totalUsage,
}: {
    totalUsage: {
        input: number;
        output: number;
        total: number;
        outputReasoning: number;
    };
}) => {
    const cards = [
        {
            label: "Input Tokens",
            value: totalUsage.input,
            icon: ArrowDownIcon,
            color: "primary" as const,
        },
        {
            label: "Output Tokens",
            value: totalUsage.output,
            icon: ArrowUpIcon,
            color: "secondary" as const,
        },
        {
            label: "Total Tokens",
            value: totalUsage.total,
            icon: LayersIcon,
            color: "tertiary" as const,
        },
        {
            label: "Reasoning",
            value: totalUsage.outputReasoning,
            icon: BrainIcon,
            color: "primary" as const,
            tooltip: "Reasoning tokens are already included in Output Tokens.",
        },
    ];

    return (
        <div className="grid grid-cols-4 gap-3">
            {cards.map((card) => {
                const Icon = card.icon;
                const styles = colorStyles[card.color];
                return (
                    <Card
                        key={card.label}
                        className="group relative overflow-hidden p-4">
                        {/* Background decoration */}
                        <div
                            className={`absolute -top-4 -right-4 size-20 rounded-full opacity-5 ${styles.bg}`}
                        />

                        <div className="relative space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div
                                        className={`flex size-7 items-center justify-center rounded-md ${styles.bgDark}`}>
                                        <Icon
                                            className={`size-4 ${styles.text}`}
                                        />
                                    </div>
                                    <span className="text-text-secondary text-sm">
                                        {card.label}
                                    </span>
                                </div>
                                {card.tooltip && (
                                    <Tooltip>
                                        <TooltipContent className="text-text-primary max-w-48 text-pretty">
                                            {card.tooltip}
                                        </TooltipContent>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="cancel"
                                                size="icon-xs">
                                                <HelpCircleIcon className="size-3.5" />
                                            </Button>
                                        </TooltipTrigger>
                                    </Tooltip>
                                )}
                            </div>
                            <p className="text-text-primary text-2xl font-semibold tabular-nums">
                                {formatNumber(card.value)}
                            </p>
                        </div>
                    </Card>
                );
            })}
        </div>
    );
};
