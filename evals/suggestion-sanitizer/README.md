# suggestion-sanitizer (removed step)

The sanitizer step left the review in #1821: on the benchmark runs it discarded nothing. Its runner is gone; `dataset/` stays because the dedup research scripts (`evals/dedup/gold-v2/`) read its labels.
