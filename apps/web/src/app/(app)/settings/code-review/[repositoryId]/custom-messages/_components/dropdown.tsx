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
import { dropdownItems, END_ONLY_PLACEHOLDERS, VARIABLE_REGEX } from "./options";

export const CustomMessagesOptionsDropdown = (props: {
    value: FormattedConfig<CustomMessageConfig["startReviewMessage"]>;
    onChange: (value: CustomMessageConfig["startReviewMessage"]) => void;
    canEdit: boolean;
    messageType:
        | "startReviewMessage"
        | "endReviewMessage"
        | "errorReviewMessage";
}) => {
    // Some placeholders (e.g. the consolidated LLM prompt) depend on data that
    // only exists after the review runs, so they're offered on the End message
    // only — never on the Start message.
    const availableItems = Object.entries(dropdownItems).filter(
        ([key]) =>
            props.messageType === "endReviewMessage" ||
            !END_ONLY_PLACEHOLDERS.has(key as keyof typeof dropdownItems),
    );
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
                {availableItems.map(([key, item]) => (
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
