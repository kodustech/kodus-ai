import type { TaskReference } from './business-validation.types';
import {
    noCapableTrackerMessage,
    noReadToolMessage,
    noTrackerMessage,
    taskNotFoundMessage,
} from './messages';

const issue: TaskReference = {
    kind: 'git_issue',
    id: '288',
    raw: '#288',
    source: 'body',
    intent: 'closes',
};

describe('noCapableTrackerMessage', () => {
    it('points to the settings when the repository reads tasks from one chosen source', () => {
        const text = noCapableTrackerMessage([issue], ['Jira'], true);
        expect(text).toContain("this repository's task source (Jira)");
        expect(text).toContain('Every connected tracker');
        expect(text).not.toContain('Connect the tracker');
    });

    it('asks to connect a tracker when every connected one was asked', () => {
        expect(noCapableTrackerMessage([issue], ['Jira'])).toContain(
            'Connect the tracker where it lives',
        );
    });
});

describe('noTrackerMessage', () => {
    it('says the chosen source is gone, not that nothing is connected', () => {
        const text = noTrackerMessage(true);
        expect(text).toContain("task source isn't connected");
        expect(text).toContain('Every connected tracker');
        expect(text).not.toContain('is connected for this organization');
    });

    it('asks to connect a tracker when the organization has none', () => {
        expect(noTrackerMessage()).toContain(
            'is connected for this organization',
        );
    });
});

describe('noReadToolMessage', () => {
    it('asks to pick the read tool instead of blaming an outage', () => {
        const text = noReadToolMessage(['Acme Tracker']);
        expect(text).toContain(
            'no tool that reads one task by its id is picked',
        );
        expect(text).not.toContain("didn't answer");
    });
});

describe('taskNotFoundMessage', () => {
    it('names only the trackers that answered the task is not there', () => {
        const text = taskNotFoundMessage([
            {
                reference: 'SAA-999',
                tracker: 'Acme Tracker',
                status: 'error',
                message:
                    'Acme Tracker has no tool that reads one task by its id',
                setup: true,
            },
            { reference: 'SAA-999', tracker: 'Linear', status: 'not_found' },
        ]);
        expect(text).toContain('SAA-999 in Linear');
        expect(text).not.toContain('Acme Tracker');
    });
});
