"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import {
    CustomMessageConfig,
    PullRequestMessageStatus,
} from "@services/pull-request-messages/types";
import { ChevronDownIcon } from "lucide-react";

import { FormattedConfig } from "../../../_types";
import { dropdownItems, VARIABLE_REGEX } from "./options";

export const CustomMessagesOptionsDropdown = (props: {
    value: FormattedConfig<CustomMessageConfig["startReviewMessage"]>;
    onChange: (value: CustomMessageConfig["startReviewMessage"]) => void;
    canEdit: boolean;
}) => {
    const allVariablesRegexSearch = useMemo(
        () => [...props.value.content.value.matchAll(VARIABLE_REGEX)],
        [props.value.content],
    );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                asChild
                disabled={
                    !props.canEdit ||
                    props.value.status.value === PullRequestMessageStatus.OFF ||
                    props.value.status.value ===
                        PullRequestMessageStatus.INACTIVE
                }>
                <Button
                    size="xs"
                    variant="helper"
                    rightIcon={<ChevronDownIcon className="-mr-1" />}>
                    Add context
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" sideOffset={0} className="w-60">
                {Object.entries(dropdownItems).map(([key, item]) => (
                    <DropdownMenuCheckboxItem
                        key={key}
                        className="min-h-auto px-4 py-2 text-xs"
                        checked={allVariablesRegexSearch.some(
                            (a) => a[1] === key,
                        )}
                        onCheckedChange={(checked) => {
                            if (checked) {
                                props.onChange({
                                    status: props.value.status.value,
                                    content: props.value.content.value
                                        .concat(`\n\n\@${key}`)
                                        .trim(),
                                });
                            } else {
                                props.onChange({
                                    status: props.value.status.value,
                                    content: props.value.content.value
                                        .replace(VARIABLE_REGEX, (match, p1) =>
                                            p1 === key ? "" : match,
                                        )
                                        .trim(),
                                });
                            }
                        }}>
                        <div>
                            {item.label}
                            <p className="text-text-tertiary text-xs">
                                {item.description}
                            </p>
                        </div>
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
