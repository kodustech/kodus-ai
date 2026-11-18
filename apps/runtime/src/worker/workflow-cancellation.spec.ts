import { DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';

import { isCancellation } from './workflow-cancellation';

describe('workflow control errors', () => {
    it('recognizes the installed SDK ownership error by constructor without requiring Error.name', () => {
        const error = new DBOSWorkflowConflictError('run-1');
        expect(error.name).toBe('Error');
        expect(isCancellation(error)).toBe(true);
    });

    it('does not classify ordinary application or registration conflicts as lost ownership', () => {
        expect(isCancellation(Object.assign(new Error('conflict'), { name: 'DBOSConflictingWorkflowError' }))).toBe(false);
        expect(isCancellation(undefined)).toBe(false);
    });
});
