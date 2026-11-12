/** A failure whose message is written for the person who ran the scan. */
export class ScanFailure extends Error {}

export const SCAN_MAP_FAILED_MESSAGE =
    "Kody could not read the repository's code to map it. Run the scan again; if it keeps failing, contact support.";
