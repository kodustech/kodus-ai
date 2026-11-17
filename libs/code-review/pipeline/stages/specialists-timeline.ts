/**
 * The "Specialist Agents" entry of the PR timeline: heavy mode's lenses as one
 * row, the list of lenses in its metadata. One row per review: a chunked
 * review runs the lenses once per batch, and every batch lands on the same row,
 * each lens keyed by lens and batch. Writes go one after another, so an update
 * never reads a row the previous one has not written yet.
 */
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import type {
    AgentProgressEvent,
    SpecialistAgentEntry,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

export const SPECIALISTS_STAGE_NAME = 'AgentReview::specialists';

export interface SpecialistsRowWriter {
    /** Creates the row in progress; resolves its id, or undefined. */
    create(
        label: string,
        metadata: Record<string, unknown>,
    ): Promise<string | undefined>;
    update(
        uuid: string,
        data: {
            status: AutomationStatus;
            message: string;
            metadata: Record<string, unknown>;
            finishedAt?: Date;
        },
    ): Promise<void>;
}

export interface SpecialistsRow {
    status: AutomationStatus;
    label: string;
    specialists: SpecialistAgentEntry[];
}

const batchOf = (e: SpecialistAgentEntry) => e.batchIndex ?? 1;

/**
 * The row for the lenses as they stand. `stoppedBatches` are the batches whose
 * generalist failed, which stops that batch's lenses: their entries stay
 * listed as stopped but leave the count, and the row reads stopped only when
 * no batch is left.
 */
export function summarizeSpecialists(
    entries: SpecialistAgentEntry[],
    stoppedBatches: ReadonlySet<number> = new Set(),
): SpecialistsRow {
    const title = 'Specialist Agents';
    const live = entries.filter((e) => !stoppedBatches.has(batchOf(e)));
    // A stopped batch's lenses stay listed, as stopped, out of the counts.
    const listed = entries.map((e) =>
        stoppedBatches.has(batchOf(e)) && e.status === 'running'
            ? { ...e, status: 'stopped' as const }
            : e,
    );
    const lenses = new Map<string, SpecialistAgentEntry[]>();
    for (const e of live) {
        lenses.set(e.label, [...(lenses.get(e.label) ?? []), e]);
    }
    const total = lenses.size;

    if (stoppedBatches.size > 0 && total === 0) {
        return {
            status: AutomationStatus.SKIPPED,
            label: `${title} — stopped because the Generalist Agent failed`,
            specialists: listed,
        };
    }
    if (total === 0) {
        return {
            status: AutomationStatus.SKIPPED,
            label: `${title} — no agent reported`,
            specialists: listed,
        };
    }
    if (live.some((e) => e.status === 'running')) {
        return {
            status: AutomationStatus.IN_PROGRESS,
            label: `${title} — running ${total} agents`,
            specialists: listed,
        };
    }

    const ran = [...lenses.values()].filter((list) =>
        list.every((e) => e.status === 'success'),
    ).length;
    const findings = live.reduce((sum, e) => sum + (e.kept ?? 0), 0);
    const status =
        ran === total
            ? AutomationStatus.SUCCESS
            : ran === 0
              ? AutomationStatus.ERROR
              : AutomationStatus.PARTIAL_ERROR;
    const ranText = ran === total ? `${total} ran` : `${ran} of ${total} ran`;
    const stopped = stoppedBatches.size;
    const stoppedText =
        stopped > 0
            ? ` · ${stopped} ${stopped === 1 ? 'batch' : 'batches'} stopped because the Generalist Agent failed`
            : '';
    return {
        status,
        label: `${title} — ${ranText} · ${findings} ${findings === 1 ? 'finding' : 'findings'}${stoppedText}`,
        specialists: listed,
    };
}

export class SpecialistsTimeline {
    private rowId?: string;
    private readonly entries = new Map<string, SpecialistAgentEntry>();
    private readonly stoppedBatches = new Set<number>();
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly writer: SpecialistsRowWriter) {}

    /** Queues the event's write behind the previous one. */
    record(event: AgentProgressEvent): Promise<void> {
        this.chain = this.chain
            .then(() => this.write(event))
            .catch(() => undefined);
        return this.chain;
    }

    private async write(event: AgentProgressEvent): Promise<void> {
        for (const e of event.specialists ?? []) {
            this.entries.set(`${e.label}#${e.batchIndex ?? 1}`, e);
        }
        if (event.specialistsStoppedByGeneralist) {
            this.stoppedBatches.add(event.batchIndex ?? 1);
        }
        const row = summarizeSpecialists(
            [...this.entries.values()],
            this.stoppedBatches,
        );
        const metadata = {
            visibility: 'secondary',
            label: row.label,
            specialists: row.specialists,
        };

        if (!this.rowId) {
            this.rowId = await this.writer.create(row.label, metadata);
            if (!this.rowId || row.status === AutomationStatus.IN_PROGRESS) {
                return;
            }
        }
        await this.writer.update(this.rowId, {
            status: row.status,
            message: row.label,
            metadata,
            ...(row.status !== AutomationStatus.IN_PROGRESS && {
                finishedAt: new Date(),
            }),
        });
    }
}
