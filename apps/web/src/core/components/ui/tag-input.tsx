import React, { useState } from "react";
import { Plus, X } from "lucide-react";

import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";

interface TagInputProps {
    tags: string[] | undefined;
    disabled?: boolean;
    id?: string;
    maxTags?: number;
    onTagsChange: (tags: string[]) => void;
    placeholder?: string;
}

const TagInput: React.FC<TagInputProps> = ({
    tags = [],
    onTagsChange,
    disabled,
    id,
    maxTags,
    placeholder = "Press Enter to add a new value",
}) => {
    const [inputValue, setInputValue] = useState("");
    const isAtLimit = maxTags !== undefined && tags.length >= maxTags;

    const addTag = (tag: string) => {
        if (!isAtLimit && tag.trim() !== "" && !tags.includes(tag.trim())) {
            onTagsChange([...tags, tag.trim()]);
            setInputValue("");
        }
    };

    const removeTag = (tagToRemove: string) => {
        onTagsChange(tags.filter((tag) => tag !== tagToRemove));
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="relative">
                <Input
                    id={id}
                    type="text"
                    disabled={disabled || isAtLimit}
                    value={inputValue}
                    maxLength={100}
                    placeholder={placeholder}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            addTag(inputValue);
                        }
                    }}
                />

                {inputValue && !isAtLimit && (
                    <Badge
                        className="absolute top-1/2 right-2 -translate-y-1/2"
                        leftIcon={<Plus className="size-3" />}
                        onClick={() => {
                            addTag(inputValue);
                        }}>
                        Add item
                    </Badge>
                )}
            </div>

            {tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {tags?.map((tag) => (
                        // A real button: a Badge renders a span, which a
                        // keyboard or a screen reader cannot use to remove.
                        <Button
                            key={tag}
                            type="button"
                            size="xs"
                            variant="helper"
                            disabled={disabled}
                            aria-label={`Remove ${tag}`}
                            onClick={() => removeTag(tag)}>
                            {tag}
                            <X className="text-danger -mr-1 h-4 w-4" />
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default TagInput;
