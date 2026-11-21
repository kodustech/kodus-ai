package main

import (
	"crypto/x509/pkix"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/localpki"
)

// runLocalPKI is `cell local-pki`: the cell host's local PKI (internal/
// localpki), for a cell whose image has no shell or openssl.
func runLocalPKI(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("cell local-pki", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", "/etc/kodus/cell", "where the local CA, the enforcers' and observers' certificates and the policy key go")
	identity := fs.String("identity", "/etc/kodus/cell/identity", "the directory cell register wrote (cert.pem, issuer.pem)")
	rotate := fs.Bool("rotate", false, "re-issue the leaf certificates; the CAs and the policy key stay")
	copies := map[string]string{}
	fs.Func("copy", "dst=src: copy src (a mounted Secret this process may read) to dst under -dir as 0600, its own (repeatable; e.g. injector/openbao-injector-role-id=/run/kodus/openbao/injector-role-id)", func(v string) error {
		dst, src, ok := strings.Cut(v, "=")
		if !ok || dst == "" || src == "" {
			return fmt.Errorf("-copy %q: want dst=src", v)
		}
		copies[dst] = src
		return nil
	})
	if err := fs.Parse(args); err != nil {
		return 2
	}
	res, err := localpki.Write(localpki.Options{Dir: *dir, IdentityDir: *identity, Rotate: *rotate, Copies: copies})
	if err != nil {
		fmt.Fprintf(stderr, "cell local-pki: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "cell local-pki: cell %s, %d files written under %s\n", res.CellID, len(res.Written), *dir)
	return 0
}

// runIssueCert is `cell issue-cert`: one leaf from a CA's files, with a
// subject Helm cannot write (the runtime-worker's OU=worker).
func runIssueCert(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("cell issue-cert", flag.ContinueOnError)
	fs.SetOutput(stderr)
	caCert := fs.String("ca-cert", "", "the issuing CA's certificate (PEM)")
	caKey := fs.String("ca-key", "", "the issuing CA's key (PEM, PKCS#8 or SEC1)")
	cn := fs.String("cn", "", "the leaf's CN")
	ou := fs.String("ou", "", "the leaf's OU (the hub reads the role from it)")
	client := fs.Bool("client", false, "clientAuth instead of serverAuth")
	cert := fs.String("cert", "", "where the leaf goes")
	key := fs.String("key", "", "where its new key goes (0600)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *caCert == "" || *caKey == "" || *cn == "" || *cert == "" || *key == "" {
		fmt.Fprintln(stderr, "cell issue-cert: -ca-cert, -ca-key, -cn, -cert and -key are required")
		return 2
	}
	subject := pkix.Name{Organization: []string{"kodus-runtime"}, CommonName: *cn}
	if *ou != "" {
		subject.OrganizationalUnit = []string{*ou}
	}
	if err := localpki.IssueLeaf(localpki.Leaf{CACert: *caCert, CAKey: *caKey, Subject: subject, ClientAuth: *client, Cert: *cert, Key: *key}); err != nil {
		fmt.Fprintf(stderr, "cell issue-cert: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "cell issue-cert: %s (OU %s) written to %s\n", *cn, *ou, *cert)
	return 0
}
