/**
 * Closes the summary Kody posts when it requests changes, on every host: a
 * reader of the request should not have to guess how it leaves.
 */
export const CHANGE_REQUEST_EXIT_NOTE =
    'Kody takes this request back once the findings above are resolved.';

export const withChangeRequestExitNote = (body: string) =>
    `${body.trim()}\n\n${CHANGE_REQUEST_EXIT_NOTE}`;
