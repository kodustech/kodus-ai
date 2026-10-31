Judge consequences supported by the comment and stated trigger. Do not invent scale, exploit success, alternative routes, recovery, or whether behavior is newly added. Internally refuted findings need validity review.

**Low:** Maintenance, cosmetic inconsistencies, minor redundant work, missing coverage of unchanged or trivial code, or fixture-fidelity gaps without demonstrated false verification. Includes test-only resource leaks without broader consequences. Small bounded N+1 loops are low; N+1 alone does not establish significant load.

**Medium:** Meaningful bounded defects: diagnostic or secondary-output errors, misleading feedback, isolated request failures, ordinary invalid-input handling, significant extra work, or limited security/privacy weaknesses. Missing coverage of substantive behavior the change adds is medium. Tests that falsely verify their claimed behavior are medium.

**High:** A supported operational path becomes unusable for valid inputs, including an identified UI path; an essential durable effect fails; a primary entity lacks its required identifier; operational data is wrongly destroyed; or a material security or operational admission control is bypassed. Includes demonstrated production outages and blocked builds/deployments.

Admission controls include seat/device/licensing caps, permitted booking windows (including date overrides and working hours), participation blocklists, and booking-lifecycle eligibility. Require actual acceptance of an ineligible booking, guest, or device; cosmetic or diagnostic mentions do not qualify.

Essential durable effects include the system’s primary records and calendar integrations. Errors confined to recipient attachments or emails are secondary output unless a stronger consequence is supported.

**Critical:** A concrete path to authentication-factor bypass, broad unauthorized administration, attacker-controlled browser/server execution, or systemic destructive loss of an entire queue or continuing work stream.

Apply the highest supported consequence. Cohort size, feature flags, rarity, and concurrency do not lower severity. Bounded duplication is medium unless it violates admission or breaks an essential operational update. Persistent cosmetic/metric errors remain bounded. Missing fields, missing await, or resource growth alone do not establish outages. Judge tests by verification harm.
