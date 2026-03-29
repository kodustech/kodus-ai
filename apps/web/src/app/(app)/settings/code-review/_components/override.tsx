"use client";

import { useEffect, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipPortal,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useEffectOnce } from "@hooks/use-effect-once";
import { Undo2 } from "lucide-react";
import { useFormContext, useWatch } from "react-hook-form";

import {
    CodeReviewFormType,
    FormattedConfigLevel,
    IFormattedConfigProperty,
} from "../_types";
import { useCodeReviewConfig } from "../../_components/context";
import { useCurrentConfigLevel } from "../../_hooks";
import {
    buildOverrideRevertState,
    isOverrideValueChanged,
} from "./override-state";

function getNestedProperty<T>(
    obj: T,
    path: string,
): IFormattedConfigProperty<any> {
    return path.split(".").reduce((acc: any, key) => acc?.[key], obj);
}

type OverrideIndicatorFormProps = {
    fieldName: string;
    className?: string;
};

export const OverrideIndicatorForm = ({
    fieldName,
}: OverrideIndicatorFormProps) => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    const currentLevel = useCurrentConfigLevel();

    const initialState = getNestedProperty(config, fieldName);
    const currentValue = useWatch({
        control: form.control,
        name: `${fieldName}.value` as any,
    });

    const handleRevert = () => {
        if (!initialState) return;

        const { value, level } = buildOverrideRevertState(
            initialState,
            currentLevel,
        );

        form.setValue(`${fieldName}.value` as any, value, {
            shouldDirty: true,
        });
        form.setValue(`${fieldName}.level` as any, level, {
            shouldDirty: true,
        });
        form.trigger(fieldName as any);
    };

    return (
        <OverrideIndicator
            currentValue={currentValue}
            initialState={initialState}
            handleRevert={handleRevert}
        />
    );
};

type OverrideIndicatorProps<T> = {
    currentValue: T;
    initialState: IFormattedConfigProperty<T>;
    handleRevert?: () => void;
};

export const OverrideIndicator = <T,>({
    currentValue,
    initialState,
    handleRevert,
}: OverrideIndicatorProps<T>) => {
    const currentLevel = useCurrentConfigLevel();
    const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
        null,
    );

    useEffectOnce(() => {
        setPortalContainer(document.body);
    });

    if (
        currentLevel === FormattedConfigLevel.GLOBAL ||
        !initialState ||
        !portalContainer
    ) {
        return null;
    }

    const isExistingOverride = initialState?.level === currentLevel;

    const parentValue = isExistingOverride
        ? initialState?.overriddenValue
        : initialState?.value;

    const parentLevel =
        (isExistingOverride
            ? initialState?.overriddenLevel
            : initialState?.level) ?? FormattedConfigLevel.DEFAULT;

    const isOverridden = isOverrideValueChanged(currentValue, parentValue);

    if (!isOverridden) {
        return null;
    }

    return (
        <div className="flex items-center gap-2">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Badge
                        onClick={(e) => e.stopPropagation()}
                        variant="primary-dark"
                        className="cursor-default px-2 py-1 text-[10px]">
                        Overridden
                    </Badge>
                </TooltipTrigger>

                {/* Prevent tooltip from being cut off in overflow hidden containers */}
                <TooltipPortal container={portalContainer}>
                    <TooltipContent>
                        <p>
                            This overrides the setting from the{" "}
                            <strong>{parentLevel}</strong> level.
                        </p>
                    </TooltipContent>
                </TooltipPortal>
            </Tooltip>
            {typeof handleRevert === "function" && (
                <div
                    onClick={(e) => {
                        e.stopPropagation();
                        handleRevert();
                    }}>
                    <Undo2 className="h-4 w-4" />
                </div>
            )}
        </div>
    );
};
