export type FeatureStage = 'alpha' | 'beta' | 'general-availability';

export type FeatureAudience = 'cloud' | 'self-hosted';

export interface SnapshotFeature {
    name: string;
    stage: FeatureStage;
    description?: string;
    documentation_url?: string;
    audience?: FeatureAudience[];
    promoted_at?: Record<string, string>;
    pr_refs?: number[];
    feature_flag_id?: number | null;
}

export interface FeaturesSnapshot {
    schema_version: 1;
    generated_at: string;
    source: 'posthog-eaf' | 'manual';
    features: Record<string, SnapshotFeature>;
}
