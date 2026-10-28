import type { ReactNode } from "react";
import { Switch } from "@components/ui/switch";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

type SettingToggleRowProps = {
    id: string;
    title: string;
    description: ReactNode;
    fieldName: string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    badge?: ReactNode;
    detail?: ReactNode;
};

export function SettingToggleRow({
    id,
    title,
    description,
    fieldName,
    checked,
    disabled,
    onCheckedChange,
    badge,
    detail,
}: SettingToggleRowProps) {
    return (
        <div className="flex min-w-0 items-start justify-between gap-4 px-5 py-4 sm:px-6">
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <label
                        htmlFor={id}
                        className="text-text-primary cursor-pointer text-sm leading-5 font-medium">
                        {title}
                    </label>
                    {badge}
                    <OverrideIndicatorForm fieldName={fieldName} />
                </div>
                <p className="text-text-secondary mt-1 text-xs leading-5">
                    {description}
                </p>
                {detail}
            </div>
            <Switch
                id={id}
                checked={checked ?? false}
                disabled={disabled}
                onCheckedChange={onCheckedChange}
                className="mt-0.5 shrink-0"
            />
        </div>
    );
}
