"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import { FormControl } from "@components/ui/form-control";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { LanguageValue } from "@services/parameters/types";
import { CheckIcon, ChevronsUpDown } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import { cn } from "src/core/utils/components";

import type { CodeReviewFormType } from "../../../_types";

const languageOptions = [
    {
        value: LanguageValue.ENGLISH,
        title: "English",
    },
    {
        value: LanguageValue.PORTUGUESE_BR,
        title: "Portuguese (Brazil)",
    },
    {
        value: LanguageValue.PORTUGUESE_PT,
        title: "Portuguese (Portugal)",
    },
    {
        value: LanguageValue.SPANISH,
        title: "Spanish",
    },
    {
        value: LanguageValue.FRENCH,
        title: "French",
    },
    {
        value: LanguageValue.GERMAN,
        title: "German",
    },
    {
        value: LanguageValue.ITALIAN,
        title: "Italian",
    },
    {
        value: LanguageValue.DUTCH,
        title: "Dutch",
    },
    {
        value: LanguageValue.POLISH,
        title: "Polish",
    },
    {
        value: LanguageValue.RUSSIAN,
        title: "Russian",
    },
    {
        value: LanguageValue.ARABIC,
        title: "Arabic",
    },
    {
        value: LanguageValue.CHINESE_MAINLAND,
        title: "Chinese (Mainland)",
    },
    {
        value: LanguageValue.HINDI,
        title: "Hindi",
    },
    {
        value: LanguageValue.JAPANESE,
        title: "Japanese",
    },
    {
        value: LanguageValue.KOREAN,
        title: "Korean",
    },
    {
        value: LanguageValue.VIETNAMESE,
        title: "Vietnamese",
    },
    {
        value: LanguageValue.THAI,
        title: "Thai",
    },
    {
        value: LanguageValue.SWEDISH,
        title: "Swedish",
    },
    {
        value: LanguageValue.FINNISH,
        title: "Finnish",
    },
    {
        value: LanguageValue.NORWEGIAN,
        title: "Norwegian",
    },
    {
        value: LanguageValue.DANISH,
        title: "Danish",
    },
    {
        value: LanguageValue.CZECH,
        title: "Czech",
    },
    {
        value: LanguageValue.HUNGARIAN,
        title: "Hungarian",
    },
    {
        value: LanguageValue.UKRAINIAN,
        title: "Ukrainian",
    },
    {
        value: LanguageValue.TAMIL,
        title: "Tamil",
    },
    {
        value: LanguageValue.TELUGU,
        title: "Telugu",
    },
    {
        value: LanguageValue.HEBREW,
        title: "Hebrew",
    },
    {
        value: LanguageValue.TURKISH,
        title: "Turkish",
    },
    {
        value: LanguageValue.INDONESIAN,
        title: "Indonesian",
    },
    {
        value: LanguageValue.MALAY,
        title: "Malay",
    },
    {
        value: LanguageValue.GREEK,
        title: "Greek",
    },
    {
        value: LanguageValue.ROMANIAN,
        title: "Romanian",
    },
    {
        value: LanguageValue.BULGARIAN,
        title: "Bulgarian",
    },
] satisfies Array<{
    value: LanguageValue;
    title: string;
}>;

export const LanguageSelector = () => {
    const form = useFormContext<CodeReviewFormType>();
    const [isPopoverOpen, setIsPopoverOpen] = useState(false);

    return (
        <Controller
            name="language"
            control={form.control}
            render={({ field }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        Kody Language
                    </FormControl.Label>

                    <FormControl.Helper className="mb-3">
                        The language Kody will use in code review responses
                    </FormControl.Helper>

                    <FormControl.Input>
                        <Popover
                            open={isPopoverOpen}
                            onOpenChange={setIsPopoverOpen}>
                            <PopoverTrigger asChild>
                                <Button
                                    size="lg"
                                    role="combobox"
                                    variant="helper"
                                    id={field.name}
                                    disabled={field.disabled}
                                    className="w-full max-w-72 justify-between"
                                    rightIcon={
                                        <ChevronsUpDown className="-mr-2 opacity-50" />
                                    }>
                                    {field.value ? (
                                        languageOptions.find(
                                            ({ value }) =>
                                                value === field.value,
                                        )?.title
                                    ) : (
                                        <span>Select language</span>
                                    )}
                                </Button>
                            </PopoverTrigger>

                            <PopoverContent align="start" className="w-72 p-0">
                                <Command
                                    filter={(value, search) => {
                                        const language = languageOptions.find(
                                            (r) =>
                                                r.value.toLowerCase() ===
                                                value.toLowerCase(),
                                        );

                                        if (!language) return 0;

                                        if (
                                            language.value
                                                .toLowerCase()
                                                .includes(
                                                    search.toLowerCase(),
                                                ) ||
                                            language.title
                                                .toLowerCase()
                                                .includes(search.toLowerCase())
                                        ) {
                                            return 1;
                                        }

                                        return 0;
                                    }}>
                                    <CommandInput placeholder="Search language..." />

                                    <CommandList>
                                        <CommandEmpty>
                                            No languages found
                                        </CommandEmpty>

                                        <CommandGroup>
                                            {languageOptions.map((l) => (
                                                <CommandItem
                                                    key={l.value}
                                                    value={l.value}
                                                    onSelect={() => {
                                                        field.onChange(l.value);
                                                        setIsPopoverOpen(false);
                                                    }}>
                                                    {l.title}
                                                    <CheckIcon
                                                        className={cn(
                                                            "text-primary-light -mr-2 size-5",
                                                            field.value ===
                                                                l.value
                                                                ? "opacity-100"
                                                                : "opacity-0",
                                                        )}
                                                    />
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>
                    </FormControl.Input>
                </FormControl.Root>
            )}
        />
    );
};
