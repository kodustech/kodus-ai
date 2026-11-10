package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// recipeName is the recipe's file name inside .kodus (recipe.Path).
var recipeName = path.Base(recipe.Path)

// applyRecipe puts the recipe the product read from the default branch in
// the checkout, over whatever the checkout carries: a PR may edit
// .kodus/workspace.yaml and that edit must not change how its own code is
// booted. Content null: the default branch has no recipe, so the checkout's
// copy goes. No recipe in the claim (an older hub): the checkout is left as
// it is.
//
// The checkout is the PR's, and os.Root follows a link that stays inside
// it: a PR that planted .kodus/workspace.yaml as a link to src/app.js had
// the recipe written over that file, and a .kodus linked to another
// directory had the recipe written (or removed) there. So, as for Kody's
// build files (authored_files.go), .kodus must be a real directory this
// cell owns, opened without following it, and the recipe replaces whatever
// entry is at its path (a link, a FIFO, a file) by an atomic rename of a
// file created exclusively beside it: the entry itself is replaced, never
// opened or followed.
func applyRecipe(repo string, r *protocol.ClaimAcquireBodyRecipe) error {
	if r == nil {
		return nil
	}
	remove := len(r.Content) == 0 || string(r.Content) == "null"
	var content string
	if !remove {
		if err := json.Unmarshal(r.Content, &content); err != nil {
			return fmt.Errorf("recipe content: %w", err)
		}
	}
	root, err := unix.Open(repo, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open the checkout: %w", err)
	}
	defer unix.Close(root)
	dir, err := openAuthoredDir(root, !remove)
	if remove && errors.Is(err, errNoAuthoredDir) {
		return nil
	}
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	if remove {
		return removeRecipe(dir)
	}
	return replaceRecipe(dir, []byte(content))
}

// removeRecipe unlinks the checkout's recipe entry, which never follows a
// link at it: the link goes, its target stays.
func removeRecipe(dir int) error {
	err := unix.Unlinkat(dir, recipeName, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	if errors.Is(err, unix.EISDIR) || errors.Is(err, unix.EPERM) {
		return recipeIsADirectory()
	}
	return fmt.Errorf("remove the checkout's recipe: %w", err)
}

// replaceRecipe writes the recipe to a new file beside the recipe's path
// (O_EXCL|O_NOFOLLOW: never an entry the checkout had) and renames it over
// that path, so whatever entry was there is replaced, not written through.
func replaceRecipe(dir int, content []byte) error {
	tmp, err := tempRecipeName()
	if err != nil {
		return err
	}
	fd, err := unix.Openat(dir, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o644)
	if err != nil {
		return fmt.Errorf("create the recipe: %w", err)
	}
	file := os.NewFile(uintptr(fd), recipe.Path)
	_, werr := file.Write(content)
	if cerr := file.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = unix.Renameat(dir, tmp, dir, recipeName)
		if errors.Is(werr, unix.EISDIR) || errors.Is(werr, unix.ENOTEMPTY) || errors.Is(werr, unix.EEXIST) {
			werr = recipeIsADirectory()
		}
	}
	if werr != nil {
		_ = unix.Unlinkat(dir, tmp, 0)
		var refused *authoredFileError
		if errors.As(werr, &refused) {
			return werr
		}
		return fmt.Errorf("write the recipe: %w", werr)
	}
	return nil
}

func recipeIsADirectory() error {
	return &authoredFileError{path: recipe.Path, reason: "is a directory in the checkout; the recipe replaces only a file there"}
}

// tempRecipeName is a name no checkout entry has yet (the create is
// exclusive anyway): random, so a PR cannot plant it ahead.
func tempRecipeName() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("recipe temp name: %w", err)
	}
	return "." + recipeName + ".kodus-" + hex.EncodeToString(b), nil
}
