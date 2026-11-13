/** A failure whose message is written for the person who ran the scan. */
export class ScanFailure extends Error {}

export const SCAN_NO_AREA_EXAMINED_MESSAGE =
    'No area could be examined: every model request failed. Check your model in AI providers, then run the scan again; it picks up the areas that failed.';

export const SCAN_MAP_FAILED_MESSAGE =
    "Kody could not read the repository's code to map it. Run the scan again; if it keeps failing, contact support.";

export const SCAN_HEAD_UNREADABLE_MESSAGE =
    'Kody could not read which commit it checked out, so the scan cannot be tied to one. Run the scan again; if it keeps failing, contact support.';

export const SCAN_NO_PROGRESS_MESSAGE =
    'The scan made no progress in its time slice: preparing the repository took the whole slice. If it keeps happening, contact support.';

export const SCAN_CHECKOUT_TAMPERED_MESSAGE =
    'A reproduction test changed the repository checkout and it could not be put back, so the scan stopped instead of reading changed code. Run the scan again.';

export const SCAN_CHECKOUT_UNVERIFIED_MESSAGE =
    'After a reproduction test, the repository checkout could not be verified, so the scan stopped instead of reading code it could not vouch for. Run the scan again.';
