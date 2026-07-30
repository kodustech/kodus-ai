"use client";

const rateColor = (rate: number) => {
    if (rate >= 0.5) return "#42be65";
    if (rate >= 0.3) return "#f2c631";
    return "#fa5867";
};

export const ImplRateBar = ({ rate }: { rate: number }) => (
    <span className="flex min-w-32 items-center gap-2.5">
        <span className="bg-card-lv3 h-1.5 flex-1 overflow-hidden rounded-full">
            <span
                className="block h-full rounded-full"
                style={{
                    width: `${Math.round(rate * 100)}%`,
                    backgroundColor: rateColor(rate),
                }}
            />
        </span>
        <span className="text-text-secondary w-9 text-right font-mono text-xs">
            {Math.round(rate * 100)}%
        </span>
    </span>
);
