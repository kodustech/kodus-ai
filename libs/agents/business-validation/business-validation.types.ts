import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type { ValidationResult } from './judge/validation.types';

/** Where in the request a task reference was written. Earlier wins. */
export type ReferenceSource = 'command' | 'title' | 'branch' | 'body';

/**
 * A task a PR points at, as written. Nothing here is confirmed: a reference
 * counts only once a tracker returns the task with this id.
 */
export type TaskReference =
    | {
          kind: 'key';
          /** `PROJ-12`, upper-cased. Jira, Linear and most custom trackers. */
          id: string;
          raw: string;
          source: ReferenceSource;
          /** Set when the key came from a tracker URL. */
          host?: 'linear' | 'jira';
          url?: string;
      }
    | {
          kind: 'git_issue';
          /** The issue number, as a string. */
          id: string;
          raw: string;
          source: ReferenceSource;
          /** Another repository than the PR's (`owner/repo#12`, issue URL). */
          repository?: { owner: string; name: string };
          url?: string;
      }
    | {
          kind: 'work_item';
          /** Azure Boards work item number (`AB#27`, `_workitems/edit/27`). */
          id: string;
          raw: string;
          source: ReferenceSource;
          url?: string;
      }
    | {
          kind: 'page';
          /** A Notion page URL; the id is the page id it ends with. */
          id: string;
          raw: string;
          source: ReferenceSource;
          url: string;
      };

/** A task as a tracker returned it. */
export interface Task {
    tracker: string;
    id: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string[];
    url?: string;
}

/** What one tracker said about one reference. */
export type TrackerLookup =
    | { status: 'found'; task: Task }
    | { status: 'not_found' }
    /** The tracker could not be reached or failed: outage, auth, timeout. */
    | { status: 'error'; message: string };

export interface ResolutionAttempt {
    reference: string;
    tracker: string;
    status: TrackerLookup['status'];
    message?: string;
}

export type TaskResolution =
    | {
          kind: 'found';
          /** Absent when the task was given as text, not referenced. */
          reference?: TaskReference;
          task: Task;
          attempts: ResolutionAttempt[];
      }
    /** The PR names no task. */
    | { kind: 'no_reference'; attempts: ResolutionAttempt[] }
    /** No task tracker is connected for the organization. */
    | { kind: 'no_tracker'; attempts: ResolutionAttempt[] }
    /** References exist, but no connected tracker reads that kind (#183 with only Linear). */
    | { kind: 'no_capable_tracker'; attempts: ResolutionAttempt[] }
    /** Every tracker that could read a reference says it does not exist. */
    | { kind: 'not_found'; attempts: ResolutionAttempt[] }
    /** A tracker that could read a reference failed. */
    | { kind: 'tracker_unavailable'; attempts: ResolutionAttempt[] };

/** Which entry point asked for the validation. */
export type ValidationDoor = 'auto' | 'force' | 'command' | 'cli';

export interface BusinessValidationRequest {
    door: ValidationDoor;
    organizationAndTeamData: OrganizationAndTeamData;
    repository?: {
        id: string;
        name: string;
        owner?: string;
        fullName?: string;
    };
    pullRequest?: {
        number: number;
        title?: string;
        body?: string;
        headRef?: string;
        baseRef?: string;
    };
    platformType?: string;
    /** What the user passed with the command or CLI: a task id, a URL or the task text itself. */
    taskInput?: string;
    /** The code to judge, or how to load it once a task was found. */
    diff: string | (() => Promise<string>);
    customInstructions?: string;
    byokModel?: string;
    byokModelId?: string;
}

export type SkipReason =
    | 'no_reference'
    | 'no_tracker'
    | 'no_capable_tracker'
    | 'task_not_found'
    | 'tracker_unavailable'
    | 'diff_unavailable'
    | 'judge_failed';

export type BusinessValidationOutcome =
    | {
          kind: 'validated';
          task: Task;
          verdict: ValidationResult;
          /** The report to post, in the team's language. */
          report: string;
      }
    /** The task was read but says too little to judge against. */
    | { kind: 'task_too_thin'; task: Task; message: string }
    /**
     * Nothing was judged. `message` explains why, for a door that must answer
     * (command, CLI); the automatic review posts nothing.
     */
    | { kind: 'skipped'; reason: SkipReason; message: string };

export interface BusinessValidationResult {
    outcome: BusinessValidationOutcome;
    references: TaskReference[];
    attempts: ResolutionAttempt[];
}
