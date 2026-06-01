/**
 * Tests for ClipboardHelpers.
 *
 * Locks in the regression that took multiple rounds to identify and
 * fix: the Radix DropdownMenu "Copy invite link" reported success but
 * the OS clipboard never received the new text because the menu's
 * focus trap reasserted focus on the menuitem `<span>` while our
 * helper was setting up the copy. The classic "hidden textarea +
 * focus + select" pattern depends on the textarea being the active
 * element when `execCommand("copy")` runs — when the focus trap
 * blocks that, the browser copies the (empty) content of the focused
 * menuitem and returns `true` ("command supported") anyway, masking
 * the failure.
 *
 * The fix replaces textarea+focus with `<div>` + Selection API: we
 * place a `Range` on the OS-level Selection without calling `.focus()`
 * on anything, which side-steps the focus trap entirely.
 *
 * Coverage:
 *   - copyTextToClipboard is sync (must return a boolean, not Promise)
 *   - Uses Selection API + div (NOT textarea/focus)
 *   - Verifies selection matches before trusting execCommand
 *   - Restores user's pre-existing Selection
 *   - Cleans up div even when execCommand throws
 *   - Falls through to fire-and-forget navigator.clipboard.writeText
 *     when sync path fails (only as a bonus — caller still sees false)
 *   - Returns false when document is unavailable (SSR-ish)
 */

import { ClipboardHelpers } from "./clipboard";

// The helper reads window/document through `globalThis as { ... }`,
// so the test mirrors that surface to simulate browser / SSR / etc.
const g = globalThis as typeof globalThis & {
    isSecureContext?: boolean;
    navigator?: Navigator;
    document?: Document;
    getSelection?: () => Selection | null;
};

let originalNavigator: Navigator | undefined;
let originalDocument: Document | undefined;
let originalGetSelection: (() => Selection | null) | undefined;

beforeEach(() => {
    originalNavigator = g.navigator;
    originalDocument = g.document;
    originalGetSelection = g.getSelection;
});

afterEach(() => {
    g.navigator = originalNavigator;
    g.document = originalDocument;
    g.getSelection = originalGetSelection;
});

/* ────────────────── sync contract ─────────────── */

describe("synchronous API — preserves user-gesture window", () => {
    it("returns a boolean (NOT a Promise) so the caller stays sync", () => {
        const execCommand = jest.fn().mockReturnValue(true);
        const selection = makeSelection({ stringValue: "text" });
        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;

        const result = ClipboardHelpers.copyTextToClipboard("text");

        expect(typeof result).toBe("boolean");
        expect(result).toBe(true);
    });
});

/* ───────────────── selection-API path (workhorse) ──────────────── */

describe("Selection-API path (works under Radix focus trap)", () => {
    it("uses a <div> with textContent, NOT textarea+focus", () => {
        const selection = makeSelection({ stringValue: "data" });
        const execCommand = jest.fn().mockReturnValue(true);
        const doc = makeDocument({ execCommand });

        g.document = doc;
        g.getSelection = () => selection;

        ClipboardHelpers.copyTextToClipboard("data");

        expect(doc.createElement).toHaveBeenCalledWith("div");
        // Crucial: the new path never depends on focus to capture the
        // text. Radix DropdownMenu's focus trap was blocking
        // textarea.focus() — the entire reason for this rewrite.
        const createdEl = (doc.createElement as jest.Mock).mock.results[0]
            .value as MockElement;
        expect(createdEl.focus).not.toHaveBeenCalled();
    });

    it("places a Range on the OS selection and calls execCommand('copy')", () => {
        const selection = makeSelection({ stringValue: "payload" });
        const execCommand = jest.fn().mockReturnValue(true);

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;

        const ok = ClipboardHelpers.copyTextToClipboard("payload");

        expect(ok).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalled();
        expect(selection.addRange).toHaveBeenCalledTimes(1);
        expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("verifies selection.toString() matches BEFORE trusting execCommand", () => {
        // Simulate a browser extension/policy that silently neutralizes
        // the Range so selection.toString() comes back empty. Even if
        // execCommand("copy") would return true ("command supported"),
        // we must return false instead of lying to the caller.
        const selection = makeSelection({ stringValue: "" });
        const execCommand = jest.fn().mockReturnValue(true);

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;

        const ok = ClipboardHelpers.copyTextToClipboard("expected");

        expect(ok).toBe(false);
        // Defensive: never call execCommand if the selection didn't
        // even hold the right text. Saves on permission prompts and
        // clipboard-noise in dev tools.
        expect(execCommand).not.toHaveBeenCalled();
    });

    it("returns false when execCommand reports failure", () => {
        const selection = makeSelection({ stringValue: "data" });
        const execCommand = jest.fn().mockReturnValue(false);

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;

        expect(ClipboardHelpers.copyTextToClipboard("data")).toBe(false);
    });

    it("returns false (no throw) when document is unavailable (SSR-ish)", () => {
        g.navigator = undefined;
        g.document = undefined;
        g.getSelection = undefined;

        expect(() =>
            ClipboardHelpers.copyTextToClipboard("text"),
        ).not.toThrow();
        expect(ClipboardHelpers.copyTextToClipboard("text")).toBe(false);
    });

    it("returns false when window.getSelection() is unavailable", () => {
        g.document = makeDocument({ execCommand: jest.fn() });
        g.getSelection = () => null;

        expect(ClipboardHelpers.copyTextToClipboard("text")).toBe(false);
    });
});

/* ──────────────────── selection preservation ───────────────────── */

describe("preserves user's pre-existing Selection", () => {
    it("snapshots existing ranges before clearing and restores them after", () => {
        const userRangeA = makeRange();
        const userRangeB = makeRange();
        const selection = makeSelection({
            stringValue: "ok",
            initialRanges: [userRangeA, userRangeB],
        });
        const execCommand = jest.fn().mockReturnValue(true);

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;

        ClipboardHelpers.copyTextToClipboard("ok");

        // The user had 2 ranges highlighted; we cleared them to put
        // OURS in, then restored both. Order matters — the test
        // mock's addRange is called: copy-range × 1, then user
        // ranges × 2 on restore.
        expect(selection.addRange).toHaveBeenCalledTimes(3);
        // Cloned ranges (NOT the originals) are restored, so the
        // helper's manipulation of its own range doesn't leak into
        // the user's selection state.
        expect(userRangeA.cloneRange).toHaveBeenCalled();
        expect(userRangeB.cloneRange).toHaveBeenCalled();
    });

    it("restores selection even when execCommand throws", () => {
        const userRange = makeRange();
        const selection = makeSelection({
            stringValue: "ok",
            initialRanges: [userRange],
        });
        const execCommand = jest.fn(() => {
            throw new Error("boom");
        });

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;

        const ok = ClipboardHelpers.copyTextToClipboard("ok");

        expect(ok).toBe(false);
        // The user's range must be restored regardless of failure —
        // wrecking the user's selection because of OUR exception
        // would be a worse UX than the failed copy itself.
        expect(userRange.cloneRange).toHaveBeenCalled();
        expect(selection.addRange).toHaveBeenCalledWith(userRange);
    });

    it("removes the div from the DOM even when execCommand throws", () => {
        const selection = makeSelection({ stringValue: "ok" });
        const div = makeElement();
        const doc = makeDocument({
            execCommand: jest.fn(() => {
                throw new Error("boom");
            }),
            createdEl: div,
        });
        g.document = doc;
        g.getSelection = () => selection;

        ClipboardHelpers.copyTextToClipboard("ok");

        expect(div.remove).toHaveBeenCalled();
    });
});

/* ──────────────── async writeText (bonus best-effort) ─────────── */

describe("async writeText fallback (bonus, doesn't change return value)", () => {
    it("fires navigator.clipboard.writeText when sync path fails — without awaiting", () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const selection = makeSelection({ stringValue: "text" });
        const execCommand = jest.fn().mockReturnValue(false);

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;
        g.navigator = { clipboard: { writeText } } as unknown as Navigator;

        const result = ClipboardHelpers.copyTextToClipboard("text");

        expect(result).toBe(false);
        expect(writeText).toHaveBeenCalledWith("text");
    });

    it("does not throw when async best-effort rejects", () => {
        const writeText = jest.fn().mockRejectedValue(new Error("denied"));
        const selection = makeSelection({ stringValue: "text" });
        const execCommand = jest.fn().mockReturnValue(false);

        g.document = makeDocument({ execCommand });
        g.getSelection = () => selection;
        g.navigator = { clipboard: { writeText } } as unknown as Navigator;

        expect(() =>
            ClipboardHelpers.copyTextToClipboard("text"),
        ).not.toThrow();
    });
});

/* ───────────────────────── test helpers ───────────────────────── */

type MockElement = {
    textContent: string;
    style: Record<string, string>;
    appendChild: jest.Mock;
    removeChild: jest.Mock;
    remove: jest.Mock;
    focus: jest.Mock;
    parentNode: MockElement | null;
};

function makeElement(): MockElement {
    const el: MockElement = {
        textContent: "",
        style: {} as Record<string, string>,
        focus: jest.fn(),
        appendChild: jest.fn((child: MockElement) => {
            child.parentNode = el;
            return child;
        }),
        removeChild: jest.fn(),
        remove: jest.fn(function (this: MockElement) {
            this.parentNode = null;
        }),
        parentNode: null,
    };
    return el;
}

function makeRange(): Range & { cloneRange: jest.Mock } {
    const range = {
        selectNodeContents: jest.fn(),
        cloneRange: jest.fn(function () {
            return range;
        }),
    } as unknown as Range & { cloneRange: jest.Mock };
    return range;
}

interface MakeSelectionOptions {
    stringValue: string;
    initialRanges?: Range[];
}

function makeSelection(opts: MakeSelectionOptions): Selection & {
    removeAllRanges: jest.Mock;
    addRange: jest.Mock;
    getRangeAt: jest.Mock;
} {
    const ranges = [...(opts.initialRanges ?? [])];
    const selection = {
        rangeCount: ranges.length,
        removeAllRanges: jest.fn(() => {
            ranges.length = 0;
        }),
        addRange: jest.fn((r: Range) => {
            ranges.push(r);
        }),
        getRangeAt: jest.fn((i: number) => ranges[i]),
        toString: () => opts.stringValue,
    } as unknown as Selection & {
        removeAllRanges: jest.Mock;
        addRange: jest.Mock;
        getRangeAt: jest.Mock;
    };
    return selection;
}

interface MakeDocumentOptions {
    execCommand: jest.Mock;
    createdEl?: MockElement;
}

function makeDocument(opts: MakeDocumentOptions): Document {
    const body = makeElement();
    const el = opts.createdEl ?? makeElement();
    return {
        body: body as unknown as HTMLElement,
        createElement: jest.fn(() => el as unknown as HTMLElement),
        createRange: jest.fn(() => makeRange() as unknown as Range),
        execCommand: opts.execCommand,
    } as unknown as Document;
}
