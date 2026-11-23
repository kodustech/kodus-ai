"use client";

import { cn } from "src/core/utils/components";

import { SETUP_STEPS } from "../_config/setup-steps";
import { useSetupStep } from "../_hooks/use-setup-step";

const StepIndicatorsRoot = (props: React.PropsWithChildren) => {
    return <div className="flex flex-row gap-2">{props.children}</div>;
};

const StepIndicatorItem = ({
    status = "inactive",
}: {
    status?: "active" | "completed" | "error" | "inactive";
}) => {
    return (
        <div
            className={cn(
                "h-2 w-10 min-w-0 shrink rounded-full",
                status === "active" && "bg-primary-light",
                status === "completed" && "bg-primary-light/20",
                status === "error" && "bg-danger",
                status === "inactive" && "bg-card-lv3/15",
            )}
        />
    );
};

const StepIndicatorsAuto = ({
    errorStepIndex,
}: {
    errorStepIndex?: number;
}) => {
    const { getStepStatus } = useSetupStep();

    return (
        <StepIndicatorsRoot>
            {SETUP_STEPS.map((_, index) => {
                const status =
                    errorStepIndex === index ? "error" : getStepStatus(index);
                return (
                    <StepIndicatorItem
                        key={SETUP_STEPS[index].id}
                        status={status}
                    />
                );
            })}
        </StepIndicatorsRoot>
    );
};

export const StepIndicators = {
    Root: StepIndicatorsRoot,
    Item: StepIndicatorItem,
    Auto: StepIndicatorsAuto,
};
