package injector

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// boundSecret is one of the claim's secrets whose value may go to this host:
// its placeholder and the value read from the store for this request.
type boundSecret struct {
	placeholder string
	value       string
}

// proxyWithSecrets serves a host the claim's placeholder secrets go to
// (docs/runtime/sandbox.md "Secrets: OpenBao"). The machine holds only
// placeholders. Here, in plaintext, the request is checked and rewritten:
//
//   - a placeholder of a secret not allowed for this host, or a real value
//     the machine should never have known, is the exfiltration alert and the
//     request stops;
//   - a placeholder allowed for this host is swapped for the store's value in
//     the headers (any header, Authorization Bearer and Basic included). The
//     URI and the body are sent as written: a placeholder there stays one;
//   - a placeholder whose secret the store no longer has for this host
//     (deleted, or the host removed) refuses the request.
//
// The values are read from the store on every request, never cached. Every
// secret the host may receive is read and masked in every response from it,
// whether this request used its placeholder or not: a host can store a
// header (x-amz-meta-*, a resource's custom field) and hand it back to a
// later request that carries no placeholder (finding 6 of the 2026-11-14
// review). See readHostSecrets for a secret the store cannot read.
//
// Residual risk, not closed here:
//   - the mask covers the spellings redact.Variants knows (plain, base64 at
//     any alignment, percent, hex, JSON escapes). A value the host transforms
//     otherwise (hashed, encrypted, compressed in a format the transport does
//     not undo, reversed, split across fields or across encodings) reaches
//     the VM as the host returns it;
//   - a deleted secret (ErrVaultDenied) has no value to mask with;
//   - the swap goes into any header, not only Authorization: the policy's
//     Secret carries no header name to restrict it to, so a placeholder in a
//     header the host stores is the way a value gets stored at all;
//   - a value stored at this host and read back through another host (a
//     host that fetches from it, or a shared backend) is masked only by
//     that host's own secrets.
func (in *Injector) proxyWithSecrets(w http.ResponseWriter, r *http.Request, info connInfo) {
	body, err := io.ReadAll(io.LimitReader(r.Body, in.MaxBody+1))
	if err != nil || int64(len(body)) > in.MaxBody {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	var head bytes.Buffer
	_ = r.Header.Write(&head)
	headers := slices.Clone(head.Bytes())
	head.WriteString(r.URL.RequestURI())
	outbound := append(head.Bytes(), body...)
	if redact.Contains(outbound, foreignPlaceholders(info.pol, info.host)) {
		in.alert(info, AlertCredentialExfiltration)
		http.Error(w, "refused", http.StatusForbidden)
		return
	}
	bound, values, ok := in.readHostSecrets(w, r, info, headers)
	if !ok {
		return
	}
	// A real value of any of the host's secrets, used or not, is one the
	// machine should never have known.
	if redact.Contains(outbound, values) {
		in.Metrics.swap("refused")
		in.alert(info, AlertCredentialExfiltration)
		http.Error(w, "refused", http.StatusForbidden)
		return
	}
	target, why := upstreamURL(r, info.host)
	if why != "" {
		in.refuseTarget(w, info, why)
		return
	}
	out, err := newUpstreamRequest(r, target, info.host, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	for k, vs := range r.Header {
		if hopByHop[http.CanonicalHeaderKey(k)] || strings.EqualFold(k, "Accept-Encoding") {
			continue // the mask reads plain bytes: the transport picks the encoding
		}
		swapped := make([]string, 0, len(vs))
		for _, v := range vs {
			swapped = append(swapped, swapPlaceholders(k, v, bound))
		}
		out.Header[k] = swapped
	}
	if len(bound) > 0 {
		in.Metrics.swap("swapped")
	}
	in.relay(w, info, out, values)
}

// readHostSecrets reads every secret of the claim the host may receive (the
// per-host list is small: one store read each). bound are the ones this
// request uses (its placeholder in a header); values are the value of every
// one the store returned, used or not, for the outbound check and the mask.
// When it returns false it has already answered the request, which did not
// go out.
//
// A secret this request uses must be readable and still allowed for the host
// (403 otherwise, as before). One it does not use:
//   - read, even if the admin since removed this host: masked;
//   - ErrVaultDenied (deleted, or not this org's): fail open. There is no
//     value to mask with, and refusing would cut the host off for the rest
//     of the claim after an ordinary admin delete;
//   - any other error (store unavailable, timeout, not configured): fail
//     closed with 502, since a value the store still holds could come back
//     unmasked. A nil store refuses the host the same way (403), as
//     Injector.Secrets documents.
func (in *Injector) readHostSecrets(w http.ResponseWriter, r *http.Request, info connInfo, headers []byte) ([]boundSecret, []string, bool) {
	var bound []boundSecret
	var values []string
	for _, s := range info.pol.SecretsFor(info.host) {
		used := bytes.Contains(headers, []byte(s.Placeholder)) || inBasicAuth(r.Header, s.Placeholder)
		if in.Secrets == nil {
			in.Metrics.swap("no_secret")
			in.Log.Warn("injector.no_secret", "claim", info.pol.ClaimID, "host", info.host, "secret", s.ID, "code", "not_configured")
			http.Error(w, "no secret store for this claim", http.StatusForbidden)
			return nil, nil, false
		}
		stored, err := in.Secrets.Secret(r.Context(), info.pol.OrgID, s.ID)
		if !used {
			switch {
			case err == nil:
				values = append(values, stored.Value)
			case errors.Is(err, ErrVaultDenied):
				// Fail open (see above). OpenBaoSecrets also answers
				// ErrVaultDenied when it refuses the injector's own token:
				// that case is the alarm on the store, not this request.
			default:
				in.Metrics.swap("no_secret")
				in.Log.Warn("injector.mask_unavailable", "claim", info.pol.ClaimID, "host", info.host, "secret", s.ID, "code", credentialFailureCode(err))
				http.Error(w, "secret store unavailable", http.StatusBadGateway)
				return nil, nil, false
			}
			continue
		}
		if err == nil && !slices.Contains(stored.Hosts, info.host) {
			err = ErrVaultDenied // the admin removed this host since the claim started
		}
		if err != nil {
			in.Metrics.swap("no_secret")
			in.Log.Warn("injector.no_secret", "claim", info.pol.ClaimID, "host", info.host, "secret", s.ID, "code", credentialFailureCode(err))
			http.Error(w, "secret not available for this host", http.StatusForbidden)
			return nil, nil, false
		}
		bound = append(bound, boundSecret{placeholder: s.Placeholder, value: stored.Value})
		values = append(values, stored.Value)
	}
	return bound, values, true
}

// foreignPlaceholders are the claim's placeholders whose secret may not go
// to host.
func foreignPlaceholders(p policy.ClaimPolicy, host string) []string {
	var out []string
	for _, s := range p.Secrets {
		if !slices.Contains(s.Hosts, host) {
			out = append(out, s.Placeholder)
		}
	}
	return out
}

// swapPlaceholders puts the values in one header value: as written, and
// inside the user:password of an Authorization Basic.
func swapPlaceholders(name, value string, bound []boundSecret) string {
	for _, b := range bound {
		value = strings.ReplaceAll(value, b.placeholder, b.value)
	}
	if !strings.EqualFold(name, "Authorization") {
		return value
	}
	scheme, encoded, ok := strings.Cut(value, " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return value
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return value
	}
	plain := string(decoded)
	for _, b := range bound {
		plain = strings.ReplaceAll(plain, b.placeholder, b.value)
	}
	if plain == string(decoded) {
		return value
	}
	return scheme + " " + base64.StdEncoding.EncodeToString([]byte(plain))
}

// inBasicAuth reports whether an Authorization Basic carries placeholder.
func inBasicAuth(h http.Header, placeholder string) bool {
	for _, v := range h.Values("Authorization") {
		scheme, encoded, ok := strings.Cut(v, " ")
		if !ok || !strings.EqualFold(scheme, "Basic") {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
		if err == nil && strings.Contains(string(decoded), placeholder) {
			return true
		}
	}
	return false
}
