/** A failure whose message is written for the person who ran the scan. */
export class ScanFailure extends Error {}

export const SCAN_NO_AREA_EXAMINED_MESSAGE =
    'No area could be examined: every model request failed. Check your model in AI providers, then run the scan again; it picks up the areas that failed.';

export const SCAN_MAP_FAILED_MESSAGE =
    "Kody could not read the repository's code to map it. Run the scan again; if it keeps failing, contact support.";
