package egress

import (
	"bytes"
	"net/http"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// ReasonPlaceholderLeak is the refusal of a plain HTTP request that carries a
// secret placeholder. No secret goes out over plain HTTP: a credentialed host
// is reached over TLS, through the injector, so a placeholder here is going to
// a host its secret was not allowed for.
const ReasonPlaceholderLeak = "placeholder_leak"

// carriesPlaceholder reads the request head (headers, Basic credentials,
// target) for any of the claim's placeholders, in every spelling redact
// knows. The body streams and is not read here.
func carriesPlaceholder(pol policy.ClaimPolicy, req *http.Request) bool {
	if req == nil || len(pol.Secrets) == 0 {
		return false
	}
	var head bytes.Buffer
	_ = req.Header.Write(&head)
	head.WriteString(req.RequestURI)
	return redact.Contains(head.Bytes(), pol.Placeholders())
}
