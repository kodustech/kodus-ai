/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import TagInput from "./tag-input";

describe("TagInput", () => {
    it("removes a tag with a button a keyboard and a screen reader can reach", () => {
        const onTagsChange = jest.fn();
        render(
            <TagInput
                tags={["src/ledger/**", "**/*.test.ts"]}
                onTagsChange={onTagsChange}
            />,
        );

        const remove = screen.getByRole("button", {
            name: "Remove src/ledger/**",
        });
        expect(remove.tagName).toBe("BUTTON");
        fireEvent.click(remove);

        expect(onTagsChange).toHaveBeenCalledWith(["**/*.test.ts"]);
    });
});
