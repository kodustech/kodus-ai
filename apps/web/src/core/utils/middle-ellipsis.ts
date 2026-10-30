const SEPARATOR = /[-_/.]/;

/**
 * Shortens `text` to at most `max` characters by cutting its middle, keeping
 * both ends: `kodus-service-billing-reconciliation-worker` →
 * `kodus-service-billing-…-worker`.
 *
 * For names where both ends carry meaning — a repository's start names the
 * product, its end tells same-prefix repositories apart — so neither a
 * trailing nor a leading ellipsis will do. The cut lands on a `-`, `_`, `/`
 * or `.` when one is close, so words stay whole. CSS can only ellipsize an
 * end, hence doing it in code.
 */
export const middleEllipsis = (text: string, max: number): string => {
    if (text.length <= max) return text;

    const budget = max - 1; // the "…" takes one
    let head = Math.ceil(budget * 0.55);
    // End the head right after a separator, a little past or before the
    // nominal split.
    for (let i = Math.min(head + 4, text.length - 1); i >= head - 6; i--) {
        if (SEPARATOR.test(text[i])) {
            head = i + 1;
            break;
        }
    }

    let tail = text.length - Math.max(budget - head, 4);
    // Start the tail on the first separator after the nominal split: only
    // ever shorter, and "…-worker" reads better than "…iation-worker".
    for (let i = tail; i < text.length - 1; i++) {
        if (SEPARATOR.test(text[i])) {
            tail = i;
            break;
        }
    }

    return `${text.slice(0, head)}…${text.slice(tail)}`;
};
