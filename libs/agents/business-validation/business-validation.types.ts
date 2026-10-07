import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type { ValidationResult } from './judge/validation.types';
import type { BusinessLogicSettings } from './settings';

/** Where in the request a task reference was written. Earlier wins. */
export type ReferenceSource = 'command' | 'title' | 'branch' | 'body';

/**
 * What the PR says it does to the task. "Part of SAA-96" delivers a slice, so
 * a missing requirement is shown but doesn't fail the check (UC-18).
 */
export type ReferenceIntent = 'closes' | 'part_of' | 'mentions';

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
          intent: ReferenceIntent;
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
          intent: ReferenceIntent;
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
          intent: ReferenceIntent;
          url?: string;
      }
    | {
          kind: 'page';
          /** A Notion page URL; the id is the page id it ends with. */
          id: string;
          raw: string;
          source: ReferenceSource;
          intent: ReferenceIntent;
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
    /** When the tracker last changed it, if it says. */
    updatedAt?: string;
    /** Images or files attached; their content is never read. */
    hasAttachments?: boolean;
    /** Long text fields beyond the description (Jira custom fields), by name. */
    fields?: Record<string, string>;
}

export interface FoundTask {
    /** Absent when the task was given as text, not referenced. */
    reference?: TaskReference;
    task: Task;
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
    | { kind: 'found'; tasks: FoundTask[]; attempts: ResolutionAttempt[] }
    /** The PR names no task. */
    | { kind: 'no_reference'; attempts: ResolutionAttempt[] }
    /** The PR states more tasks than one validation covers (a release, a merge). */
    | { kind: 'too_many_references'; attempts: ResolutionAttempt[] }
    /** No task tracker is connected for the organization. */
    | { kind: 'no_tracker'; attempts: ResolutionAttempt[] }
    /** References exist, but no connected tracker reads that kind (#183 with only Linear). */
    | { kind: 'no_capable_tracker'; attempts: ResolutionAttempt[] }
    /**
     * Every tracker that could read a reference says it does not exist.
     * `looksIntended` when the tracker has a team or project with that prefix,
     * so it reads as a typo rather than a version number.
     */
    | {
          kind: 'not_found';
          looksIntended: boolean;
          /** The reference that reads as a typo, and real tasks one typo away. */
          intended?: {
              reference: TaskReference;
              tracker: string;
              nearby: string[];
          };
          attempts: ResolutionAttempt[];
      }
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
    /** The team's Business Logic settings; defaults when absent. */
    settings?: BusinessLogicSettings;
    /**
     * The author disputes findings (UC-38): what they said, for the judge to
     * check against the diff before keeping or changing those states.
     */
    authorClaim?: { claim: string; requirements: string[]; files: string[] };
}

export type SkipReason =
    | 'no_reference'
    | 'too_many_references'
    | 'no_tracker'
    | 'no_capable_tracker'
    | 'task_not_found'
    | 'tracker_unavailable'
    | 'diff_unavailable'
    | 'judge_failed';

/** One task judged against the PR. */
export interface TaskCheck {
    task: Task;
    reference?: TaskReference;
    verdict: ValidationResult;
    /** Whether this task alone lets the check pass, under the team's settings. */
    passed: boolean;
    /** When the task was read, so a later edit to it is visible (UC-25). */
    readAt: string;
}

export type BusinessValidationOutcome =
    | {
          kind: 'validated';
          checks: TaskCheck[];
          /** Tasks that were read but say too little to judge. */
          thinTasks: Task[];
          passed: boolean;
          /** Changed files left out because the diff was over budget. */
          unseenFiles: string[];
      }
    /** Every task read says too little to judge against. */
    | { kind: 'task_too_thin'; tasks: Task[]; message: string }
    /**
     * The reference looks like a real task id (its prefix is a team in the
     * tracker) but no such task exists: worth telling the author (UC-21).
     */
    | {
          kind: 'task_missing';
          references: TaskReference[];
          tracker: string;
          message: string;
      }
    /**
     * Nothing was judged. `message` explains why, for a door that must answer
     * (command, CLI); the automatic review posts nothing.
     */
    | { kind: 'skipped'; reason: SkipReason; message: string };

export interface BusinessValidationResult {
    outcome: BusinessValidationOutcome;
    references: TaskReference[];
    attempts: ResolutionAttempt[];
    /** The trackers that were asked, in connection order. */
    trackers: string[];
}
