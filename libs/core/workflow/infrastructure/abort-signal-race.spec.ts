import { raceWithAbortSignal, JobAbortedError } from './abort-signal-race';
import { SlicePreemptedError } from '@libs/core/workflow/domain/errors/slice-preempted.error';

describe('raceWithAbortSignal', () => {
    it('rejects with JobAbortedError when the signal has no slice reason', async () => {
        const abort = new AbortController();
        const work = new Promise<void>(() => undefined);
        const racing = raceWithAbortSignal(work, abort.signal);
        abort.abort();
        await expect(racing).rejects.toBeInstanceOf(JobAbortedError);
    });

    it('rejects with SlicePreemptedError when that is the abort reason', async () => {
        const abort = new AbortController();
        const work = new Promise<void>(() => undefined);
        const racing = raceWithAbortSignal(work, abort.signal);
        abort.abort(new SlicePreemptedError());
        await expect(racing).rejects.toBeInstanceOf(SlicePreemptedError);
    });
});
