/** @jest-environment jsdom */
import { act, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { RichTextEditor } from "./rich-text-editor";

jest.mock("src/core/utils/components", () => ({ cn: () => "" }));

jest.mock("./rich-text-editor-toolbar", () => ({
    RichTextEditorToolbar: () => null,
}));
jest.mock("./rich-text-editor-search", () => ({
    RichTextEditorSearch: () => null,
}));

describe("RichTextEditor controlled synchronization", () => {
    let editor: Editor;
    beforeEach(() => {
        editor = undefined as unknown as Editor;
    });
    const capture = (instance: Editor | null) => {
        if (instance) editor = instance;
    };

    it("loads an external value without emitting a user edit", async () => {
        const onChange = jest.fn();
        const props = {
            onChangeAction: onChange,
            editorInstanceAction: capture,
        };
        const { rerender } = render(<RichTextEditor value="" {...props} />);
        await waitFor(() => expect(editor).toBeDefined());
        rerender(<RichTextEditor value="Read @file:src/a.ts" {...props} />);
        expect(editor.getText()).toBe("Read @file:src/a.ts");
        expect(onChange).not.toHaveBeenCalled();
    });

    it("does not restore an unchanged JSON prop over local typing", async () => {
        const value = {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [{ type: "text", text: "Read @file:src/a.ts" }],
                },
            ],
        };
        const props = {
            onChangeAction: jest.fn(),
            editorInstanceAction: capture,
            saveFormat: "json" as const,
        };
        const { rerender } = render(
            <RichTextEditor value={value} {...props} />,
        );
        await waitFor(() => expect(editor).toBeDefined());
        act(() => {
            editor.commands.insertContentAt(
                editor.state.doc.content.size - 1,
                " now",
            );
        });
        rerender(
            <RichTextEditor
                value={JSON.parse(JSON.stringify(value))}
                {...props}
            />,
        );
        expect(editor.getText()).toBe("Read @file:src/a.ts now");
    });

    it("still applies an explicit external reset after local edits", async () => {
        const onChange = jest.fn();
        const props = {
            onChangeAction: onChange,
            editorInstanceAction: capture,
        };
        const { rerender } = render(
            <RichTextEditor value="Initial" {...props} />,
        );
        await waitFor(() => expect(editor).toBeDefined());
        act(() => {
            editor.commands.insertContent("Typed");
        });
        onChange.mockClear();
        rerender(<RichTextEditor value="Replacement" {...props} />);
        expect(editor.getText()).toBe("Replacement");
        expect(onChange).not.toHaveBeenCalled();
        rerender(<RichTextEditor value="Replacement" disabled {...props} />);
        expect(editor.isEditable).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("preserves the document and selection when the parent echoes edits", async () => {
        function Controlled() {
            const [value, setValue] = useState<string | object>(
                "Read @file:src/a.ts",
            );
            return (
                <RichTextEditor
                    value={value}
                    saveFormat="text"
                    onChangeAction={setValue}
                    editorInstanceAction={capture}
                />
            );
        }
        render(<Controlled />);
        await waitFor(() => expect(editor).toBeDefined());
        const replace = jest.spyOn(editor.commands, "setContent");
        for (const char of " updated") {
            act(() => {
                editor.commands.insertContentAt(
                    editor.state.doc.content.size - 1,
                    char,
                );
            });
        }
        expect(editor.getText()).toBe("Read @file:src/a.ts updated");
        expect(replace).not.toHaveBeenCalled();
        expect(editor.state.selection.from).toBe(
            editor.state.doc.content.size - 1,
        );
    });
});
