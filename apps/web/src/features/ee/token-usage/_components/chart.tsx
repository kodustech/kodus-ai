"use client";

import { use, useEffect, useMemo, useState } from "react";
import useResizeObserver from "@hooks/use-resize-observer";
import { BaseUsageContract } from "@services/usage/types";
import { ExpandableContext } from "src/core/providers/expandable";
import {
    VictoryAxis,
    VictoryBar,
    VictoryChart,
    VictoryContainer,
    VictoryScatter,
    VictoryStack,
    VictoryTooltip,
} from "victory";

// Chart colors - using distinct, accessible colors
const CHART_COLORS = {
    input: "#3b82f6", // blue
    output: "#22c55e", // green
    reasoning: "#f97316", // orange
};

const legendData = [
    { name: "Input", color: CHART_COLORS.input },
    { name: "Output", color: CHART_COLORS.output },
    { name: "Reasoning", color: CHART_COLORS.reasoning },
];

export const Chart = ({
    data,
    filterType,
}: {
    data: Array<
        BaseUsageContract & {
            prNumber?: number;
            developer?: string;
            date?: string;
        }
    >;
    filterType: string;
}) => {
    const [graphRef, boundingRect] = useResizeObserver();
    const { isExpanded } = use(ExpandableContext);
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    const getXAccessor = () => {
        switch (filterType) {
            case "daily":
                return "date";
            case "by-pr":
                return "prNumber";
            case "by-developer":
                return "developer";
            default:
                return "date";
        }
    };

    const xAccessor = getXAccessor();

    const transformedData = useMemo(() => {
        const merged: Record<string, any> = {};
        data.forEach((d) => {
            const key =
                filterType === "by-pr"
                    ? `#${d[xAccessor]}`
                    : String(d[xAccessor]);

            if (!merged[key]) {
                merged[key] = {
                    ...d,
                    [xAccessor]: key,
                    input: d.input || 0,
                    output: d.output || 0,
                    outputReasoning: d.outputReasoning || 0,
                };
            } else {
                merged[key].input += d.input || 0;
                merged[key].output += d.output || 0;
                merged[key].outputReasoning += d.outputReasoning || 0;
            }
        });

        return Object.values(merged);
    }, [data, filterType, xAccessor]);

    const { maxDomain, chartData } = useMemo(() => {
        const totals = transformedData.map(
            (d) => d.input + d.output + d.outputReasoning,
        );

        if (totals.length === 0) {
            return { maxDomain: undefined, chartData: transformedData };
        }

        const sortedTotals = [...totals].sort((a, b) => a - b);
        const percentile95Index = Math.floor(sortedTotals.length * 0.95);
        const percentile95 = sortedTotals[percentile95Index];
        const maxValue = sortedTotals[sortedTotals.length - 1];

        if (maxValue > percentile95 * 3) {
            const capLimit = percentile95 * 1.2;

            const cappedData = transformedData.map((d) => {
                const total = d.input + d.output + d.outputReasoning;
                const isCapped = total > capLimit;

                if (isCapped) {
                    const ratio = capLimit / total;
                    return {
                        ...d,
                        isCapped: true,
                        originalInput: d.input,
                        originalOutput: d.output,
                        originalOutputReasoning: d.outputReasoning,
                        input: d.input * ratio,
                        output: d.output * ratio,
                        outputReasoning: d.outputReasoning * ratio,
                    };
                }

                return {
                    ...d,
                    isCapped: false,
                    originalInput: d.input,
                    originalOutput: d.output,
                    originalOutputReasoning: d.outputReasoning,
                };
            });

            return {
                maxDomain: capLimit,
                chartData: cappedData,
            };
        }

        return { maxDomain: undefined, chartData: transformedData };
    }, [transformedData]);

    const isTiltedDate = chartData?.length > 6 && !isExpanded;

    const minBarWidth = 40;
    const minWidth = chartData.length * minBarWidth;
    const chartWidth = Math.max(boundingRect.width, minWidth);
    const shouldScroll = chartWidth > boundingRect.width;

    const getTickFormat = (x: any) => {
        if (filterType === "daily") {
            return new Date(x).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
            });
        }
        return x;
    };

    const formatTicks = (t: number) => {
        if (t === 0) return "0";
        if (t < 1000) return t.toString();
        if (t < 1000000) return `${(t / 1000).toFixed(1)}K`;
        return `${(t / 1000000).toFixed(1)}M`;
    };

    if (!isMounted) {
        return <div ref={graphRef} className="h-full w-full" />;
    }

    return (
        <div ref={graphRef} className="flex h-full w-full flex-col">
            {/* Custom Legend */}
            <div className="mb-2 flex items-center justify-center gap-6">
                {legendData.map((item) => (
                    <div key={item.name} className="flex items-center gap-2">
                        <div
                            className="size-3 rounded-sm"
                            style={{ backgroundColor: item.color }}
                        />
                        <span className="text-text-secondary text-xs">
                            {item.name}
                        </span>
                    </div>
                ))}
            </div>

            <div
                className={shouldScroll ? "overflow-x-auto" : ""}
                style={{ maxHeight: boundingRect.height - 40 }}>
                <VictoryChart
                    width={chartWidth}
                    height={
                        shouldScroll
                            ? boundingRect.height - 60
                            : boundingRect.height - 40
                    }
                    domainPadding={{ x: 25 }}
                    domain={maxDomain ? { y: [0, maxDomain] } : undefined}
                    padding={{
                        left: 55,
                        right: 20,
                        top: 10,
                        bottom: isTiltedDate ? 50 : 30,
                    }}
                    containerComponent={
                        <VictoryContainer responsive={false} />
                    }>
                    <VictoryAxis
                        tickFormat={getTickFormat}
                        style={{
                            axis: {
                                stroke: "#374151",
                                strokeWidth: 1,
                            },
                            tickLabels: {
                                fontSize: 11,
                                fill: "#9ca3af",
                                fontFamily: "system-ui, sans-serif",
                                padding: 8,
                                angle: isTiltedDate && !isExpanded ? -35 : 0,
                                textAnchor:
                                    isTiltedDate && !isExpanded
                                        ? "end"
                                        : "middle",
                            },
                            grid: {
                                stroke: "none",
                            },
                        }}
                    />
                    <VictoryAxis
                        dependentAxis
                        tickFormat={formatTicks}
                        style={{
                            axis: {
                                stroke: "#374151",
                                strokeWidth: 1,
                            },
                            tickLabels: {
                                fontSize: 11,
                                fill: "#9ca3af",
                                fontFamily: "system-ui, sans-serif",
                                padding: 8,
                            },
                            grid: {
                                stroke: "#1f2937",
                                strokeWidth: 1,
                            },
                        }}
                    />
                    <VictoryStack
                        style={{
                            data: {
                                width: Math.min(
                                    24,
                                    chartWidth / chartData.length / 2,
                                ),
                            },
                        }}>
                        <VictoryBar
                            data={chartData.map((d) => ({
                                x: d[xAccessor],
                                y: d.input,
                                isCapped: d.isCapped,
                                originalValue: d.originalInput,
                            }))}
                            style={{
                                data: {
                                    fill: CHART_COLORS.input,
                                    rx: 2,
                                },
                            }}
                            labels={({ datum }) =>
                                datum?.isCapped
                                    ? `Input: ${formatTicks(datum?.originalValue)} (capped)`
                                    : `Input: ${formatTicks(datum?.y)}`
                            }
                            labelComponent={
                                <VictoryTooltip
                                    flyoutStyle={{
                                        fill: "#1f2937",
                                        stroke: "#374151",
                                        strokeWidth: 1,
                                    }}
                                    style={{
                                        fill: "#f3f4f6",
                                        fontSize: 11,
                                        fontFamily: "system-ui, sans-serif",
                                    }}
                                    cornerRadius={6}
                                    flyoutPadding={{
                                        top: 6,
                                        bottom: 6,
                                        left: 10,
                                        right: 10,
                                    }}
                                />
                            }
                        />
                        <VictoryBar
                            data={chartData.map((d) => ({
                                x: d[xAccessor],
                                y: d.output,
                                isCapped: d.isCapped,
                                originalValue: d.originalOutput,
                            }))}
                            style={{
                                data: {
                                    fill: CHART_COLORS.output,
                                },
                            }}
                            labels={({ datum }) =>
                                datum?.isCapped
                                    ? `Output: ${formatTicks(datum?.originalValue)} (capped)`
                                    : `Output: ${formatTicks(datum?.y)}`
                            }
                            labelComponent={
                                <VictoryTooltip
                                    flyoutStyle={{
                                        fill: "#1f2937",
                                        stroke: "#374151",
                                        strokeWidth: 1,
                                    }}
                                    style={{
                                        fill: "#f3f4f6",
                                        fontSize: 11,
                                        fontFamily: "system-ui, sans-serif",
                                    }}
                                    cornerRadius={6}
                                    flyoutPadding={{
                                        top: 6,
                                        bottom: 6,
                                        left: 10,
                                        right: 10,
                                    }}
                                />
                            }
                        />
                        <VictoryBar
                            data={chartData.map((d) => ({
                                x: d[xAccessor],
                                y: d.outputReasoning,
                                isCapped: d.isCapped,
                                originalValue: d.originalOutputReasoning,
                            }))}
                            style={{
                                data: {
                                    fill: CHART_COLORS.reasoning,
                                    rx: 2,
                                },
                            }}
                            labels={({ datum }) =>
                                datum?.isCapped
                                    ? `Reasoning: ${formatTicks(datum?.originalValue)} (capped)`
                                    : `Reasoning: ${formatTicks(datum?.y)}`
                            }
                            labelComponent={
                                <VictoryTooltip
                                    flyoutStyle={{
                                        fill: "#1f2937",
                                        stroke: "#374151",
                                        strokeWidth: 1,
                                    }}
                                    style={{
                                        fill: "#f3f4f6",
                                        fontSize: 11,
                                        fontFamily: "system-ui, sans-serif",
                                    }}
                                    cornerRadius={6}
                                    flyoutPadding={{
                                        top: 6,
                                        bottom: 6,
                                        left: 10,
                                        right: 10,
                                    }}
                                />
                            }
                        />
                    </VictoryStack>
                    {maxDomain && (
                        <VictoryScatter
                            data={chartData
                                .filter((d) => d.isCapped)
                                .map((d) => ({
                                    x: d[xAccessor],
                                    y: maxDomain * 0.98,
                                }))}
                            size={5}
                            style={{
                                data: {
                                    fill: "#eab308",
                                    stroke: "#1f2937",
                                    strokeWidth: 2,
                                },
                            }}
                            labels={() => "Value exceeds scale"}
                            labelComponent={
                                <VictoryTooltip
                                    flyoutStyle={{
                                        fill: "#1f2937",
                                        stroke: "#374151",
                                        strokeWidth: 1,
                                    }}
                                    style={{
                                        fill: "#f3f4f6",
                                        fontSize: 11,
                                        fontFamily: "system-ui, sans-serif",
                                    }}
                                    cornerRadius={6}
                                    flyoutPadding={{
                                        top: 6,
                                        bottom: 6,
                                        left: 10,
                                        right: 10,
                                    }}
                                />
                            }
                        />
                    )}
                </VictoryChart>
            </div>

            {maxDomain && (
                <div className="text-warning mt-2 flex items-center gap-2 px-2 text-xs">
                    <div className="bg-warning size-2 rounded-full" />
                    <span>
                        Some values exceed the scale. Hover over bars to see
                        actual values.
                    </span>
                </div>
            )}
        </div>
    );
};
