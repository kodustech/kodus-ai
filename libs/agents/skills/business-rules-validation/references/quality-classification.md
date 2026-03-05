# Task Quality Classification

The runtime classifies task context quality BEFORE the LLM analysis.
Do NOT reclassify - use the provided classification.

## Levels

### COMPLETE
- Has title, description, and acceptance criteria
- Analysis should be thorough and criterion-by-criterion against diff

### PARTIAL
- Has title and description but no acceptance criteria
- Run best-effort analysis from described business behavior
- Explicitly note missing acceptance criteria

### MINIMAL
- Has only title (or very short description)
- Be conservative and flag only obvious requirement gaps
- Recommend adding task detail

### EMPTY
- No meaningful task context found
- Runtime should short-circuit before analyzer
- If analyzer receives EMPTY, return `needsMoreInfo = true`
