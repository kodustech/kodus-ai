import {
    CHANGE_REQUEST_EXIT_NOTE,
    withChangeRequestExitNote,
} from './changeRequestNote';

describe('withChangeRequestExitNote', () => {
    it('closes the summary with how the request leaves, one blank line below it', () => {
        expect(withChangeRequestExitNote('# Title\n\n- issue\n\n\n')).toBe(
            `# Title\n\n- issue\n\n${CHANGE_REQUEST_EXIT_NOTE}`,
        );
        expect(CHANGE_REQUEST_EXIT_NOTE).toBe(
            'Kody takes this request back once the findings above are resolved.',
        );
    });
});
