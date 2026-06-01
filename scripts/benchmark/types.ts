export type Severity = "Critical" | "High" | "Medium" | "Low";

export interface GoldenComment {
  comment: string;
  severity: Severity;
}

export interface GoldenPR {
  pr_title: string;
  url: string;
  original_url?: string;
  comments: GoldenComment[];
}

export interface BenchmarkPR {
  repo: string;
  head: string;
  base: string;
  title: string;
  source_url: string;
  golden_comments: GoldenComment[];
}

export interface BenchmarkData {
  prs: BenchmarkPR[];
}

export interface CandidateIssue {
  pr_title: string;
  pr_url: string;
  tool: string;
  issues: {
    comment: string;
    file?: string;
    line?: number;
  }[];
}

export interface JudgeMatch {
  golden_comment: string;
  candidate_comment: string;
  reasoning: string;
  match: boolean;
  confidence: number;
}

export interface PREvaluation {
  pr_title: string;
  repo: string;
  source_url: string;
  tool: string;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
  matches: JudgeMatch[];
  comment: string;
}

export interface BenchmarkResults {
  evaluated_at: string;
  tool: string;
  summary: {
    total_prs: number;
    total_golden_comments: number;
    total_true_positives: number;
    total_false_positives: number;
    total_false_negatives: number;
    precision: number;
    recall: number;
    f1: number;
  };
  by_repo: Record<
    string,
    {
      prs: number;
      golden_comments: number;
      true_positives: number;
      false_positives: number;
      false_negatives: number;
      precision: number;
      recall: number;
      f1: number;
    }
  >;
  by_severity: Record<
    Severity,
    {
      total: number;
      found: number;
      recall: number;
    }
  >;
  evaluations: PREvaluation[];
}
