export const ClipboardHelpers = {
    copyTextToClipboard: (text: string): boolean => {
        if (selectAndExec(text)) {
            return true;
        }

        const clipboard = (globalThis as { navigator?: Navigator }).navigator
            ?.clipboard;
        if (clipboard?.writeText) {
            void clipboard.writeText(text).catch(() => {});
        }

        return false;
    },
};

function selectAndExec(text: string): boolean {
    const doc = (globalThis as { document?: Document }).document;
    const win = (globalThis as { getSelection?: () => Selection | null })
        .getSelection
        ? (globalThis as unknown as Window)
        : null;

    if (!doc?.body || !win) {
        return false;
    }

    const div = doc.createElement('div');
    div.textContent = text;
    div.style.position = 'fixed';
    div.style.left = '-9999px';
    div.style.top = '0';
    div.style.whiteSpace = 'pre';
    doc.body.appendChild(div);

    const selection = win.getSelection();
    if (!selection) {
        div.remove();
        return false;
    }

    const previousRanges: Range[] = [];
    for (let i = 0; i < selection.rangeCount; i++) {
        previousRanges.push(selection.getRangeAt(i).cloneRange());
    }

    try {
        selection.removeAllRanges();
        const range = doc.createRange();
        range.selectNodeContents(div);
        selection.addRange(range);

        if (selection.toString() !== text) {
            return false;
        }

        return doc.execCommand('copy');
    } catch {
        return false;
    } finally {
        selection.removeAllRanges();
        for (const r of previousRanges) {
            selection.addRange(r);
        }
        div.remove();
    }
}
