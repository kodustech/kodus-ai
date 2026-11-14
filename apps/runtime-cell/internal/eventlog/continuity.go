package eventlog

import "errors"

const (
	Version          = "1"
	HeaderVersion    = "X-Kodus-Eventlog-Version"
	HeaderEpoch      = "X-Kodus-Eventlog-Epoch"
	HeaderOldest     = "X-Kodus-Eventlog-Oldest"
	HeaderLatest     = "X-Kodus-Eventlog-Latest"
	HeaderContinuity = "X-Kodus-Eventlog-Continuity"
)

// Reason names only local feed health, never a claim's security verdict.
type Reason string

const (
	ReasonOK              Reason = "ok"
	ReasonProducerRestart Reason = "producer_restart"
	ReasonRetentionGap    Reason = "retention_gap"
	ReasonCursorInvalid   Reason = "cursor_invalid"
	ReasonUnsupported     Reason = "unsupported_feed"
	ReasonInvalid         Reason = "invalid_feed"
	ReasonUnavailable     Reason = "source_unavailable"
)

// FeedError carries a closed reason, without an upstream response or URL.
type FeedError struct{ Reason Reason }

func (e *FeedError) Error() string { return "eventlog: " + string(e.Reason) }

// HistoryLost cannot be repaired by retrying with a fresh cursor.
func HistoryLost(err error) bool {
	var e *FeedError
	return errors.As(err, &e) && (e.Reason == ReasonProducerRestart || e.Reason == ReasonRetentionGap || e.Reason == ReasonCursorInvalid)
}

func FailureReason(err error) Reason {
	var e *FeedError
	if errors.As(err, &e) {
		switch e.Reason {
		case ReasonProducerRestart, ReasonRetentionGap, ReasonCursorInvalid, ReasonUnsupported, ReasonInvalid, ReasonUnavailable:
			return e.Reason
		}
	}
	return ReasonUnavailable
}
