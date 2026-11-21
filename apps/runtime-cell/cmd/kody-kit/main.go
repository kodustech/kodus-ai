// Command kody-kit builds and checks the microVM kit
// (apps/runtime-cell/microvm-kit, internal/kit):
//
//	kody-kit rootfs   -oci <layout dir|tar> | -tar <rootfs tar>  -platform linux/amd64
//	                  -profile sandbox|environment -guest <kody-guest> -out <x.ext4>
//	kody-kit manifest -dir <kit> -arch x86_64 -firecracker-version v1.17.0 -kernel-version 6.1.188
//	kody-kit verify   -dir <kit> -digest sha256:<hex> -arch x86_64
//
// rootfs needs mkfs.ext4 from e2fsprogs 1.47.1 or later and libarchive.
// manifest prints the digest the cell pins (-firecracker-kit-digest).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/rootfs"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: kody-kit rootfs|manifest|verify ...")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "rootfs":
		err = buildRootfs(os.Args[2:])
	case "manifest":
		err = manifest(os.Args[2:])
	case "verify":
		err = verify(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "kody-kit:", err)
		os.Exit(1)
	}
}

func buildRootfs(args []string) error {
	fs := flag.NewFlagSet("rootfs", flag.ExitOnError)
	oci := fs.String("oci", "", "OCI image layout, a directory or a tar (docker save, buildx --output type=oci)")
	tarPath := fs.String("tar", "", "one tar of a whole file system instead of -oci")
	platform := fs.String("platform", "linux/amd64", "the image's platform in the layout")
	profile := fs.String("profile", "", "sandbox | environment")
	guestBin := fs.String("guest", "", "the guest agent binary (cmd/kody-guest for the target arch)")
	out := fs.String("out", "", "the ext4 image to write")
	extra := fs.Int("extra-mb", -1, "free space on top of the files (default: 64 for a sandbox, 1024 for an environment)")
	mkfs := fs.String("mkfs", "mkfs.ext4", "mkfs.ext4 binary")
	_ = fs.Parse(args)
	if (*oci == "") == (*tarPath == "") || *guestBin == "" || *out == "" {
		return errors.New("rootfs needs one of -oci and -tar, -guest and -out")
	}
	p, err := guestinit.ProfileByName(*profile)
	if err != nil {
		return err
	}
	g, err := os.ReadFile(*guestBin)
	if err != nil {
		return err
	}
	scratch, err := os.MkdirTemp("", "kody-rootfs-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(scratch) }()
	var layers []rootfs.Layer
	if *oci != "" {
		l, err := rootfs.OpenLayout(*oci, scratch+"/layout")
		if err != nil {
			return err
		}
		if layers, err = l.Layers(*platform); err != nil {
			return err
		}
	} else {
		layers = []rootfs.Layer{rootfs.TarLayer(*tarPath)}
	}
	if *extra < 0 {
		*extra = 64
		if p.Name == guestinit.Environment {
			*extra = 1024
		}
	}
	date := time.Time{}
	if s := os.Getenv("SOURCE_DATE_EPOCH"); s != "" {
		sec, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return fmt.Errorf("SOURCE_DATE_EPOCH: %w", err)
		}
		date = time.Unix(sec, 0)
	}
	return rootfs.Build(context.Background(), layers, rootfs.Options{Profile: p, Guest: g, ModTime: date},
		rootfs.Ext4{Mkfs: *mkfs, Label: "kody-" + p.Name, ExtraMB: *extra, SourceDate: date}, scratch, *out)
}

func manifest(args []string) error {
	fs := flag.NewFlagSet("manifest", flag.ExitOnError)
	dir := fs.String("dir", "", "the kit directory")
	arch := fs.String("arch", "", "x86_64 | arm64")
	fc := fs.String("firecracker-version", "", "firecracker and jailer release (v1.17.0)")
	kv := fs.String("kernel-version", "", "guest kernel version (6.1.188)")
	_ = fs.Parse(args)
	digest, err := kit.Make(*dir, *arch, *fc, *kv)
	if err != nil {
		return err
	}
	fmt.Println(digest)
	return nil
}

func verify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	dir := fs.String("dir", "", "the kit directory")
	digest := fs.String("digest", "", "the manifest digest the cell pins")
	arch := fs.String("arch", "", "x86_64 | arm64")
	_ = fs.Parse(args)
	k, err := kit.Load(*dir, *digest, *arch)
	if err != nil {
		return err
	}
	fmt.Printf("kit %s: firecracker %s, kernel %s, nestedDocker %v\n", k.Digest, k.Manifest.FirecrackerVersion, k.Manifest.KernelVersion, k.NestedDocker())
	return nil
}
