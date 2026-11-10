package protocol

import (
	"errors"
	"fmt"
	"regexp"
)

// The bounds of claim.acquire recipe.files, the build files Kody wrote with
// an authored recipe (AUTHORED_FILES_LIMITS and authoredFilesProblem in
// libs/runtime/contracts/authored-files.ts). The JSON Schema carries the
// path pattern and the per-file length; the byte sums, the duplicates and
// the recipe paths are zod refinements, mirrored here.
const (
	MaxAuthoredFiles        = 4
	MaxAuthoredFileBytes    = 16 * 1024
	MaxAuthoredFilesBytes   = 48 * 1024
	authoredFilesNeedRecipe = "files: authored files come only with a recipe"
)

// AuthoredFilePath is a file directly under .kodus/ whose name starts with a
// letter or a digit: never "." or "..", never a nested path.
var AuthoredFilePath = regexp.MustCompile(`^\.kodus/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// recipeFilePaths are RECIPE_FILE_PATHS: the cell boots its recipe from the
// claim, so no authored file may stand in one of these paths.
var recipeFilePaths = map[string]bool{".kodus/workspace.runtime.yaml": true, ".kodus/workspace.yaml": true}

// ErrAuthoredFiles is every refusal of CheckAuthoredFiles.
var ErrAuthoredFiles = errors.New("authored files refused")

// CheckAuthoredFiles is every rule a list of authored files must pass, the
// schema's and the refinements'. The cell checks it again right before it
// writes them (agent.writeAuthoredFiles), whatever decoded the frame.
func CheckAuthoredFiles(files []AuthoredFile) error {
	if len(files) > MaxAuthoredFiles {
		return fmt.Errorf("%w: at most %d files", ErrAuthoredFiles, MaxAuthoredFiles)
	}
	seen := make(map[string]bool, len(files))
	total := 0
	for _, f := range files {
		if !AuthoredFilePath.MatchString(f.Path) {
			return fmt.Errorf("%w: %q is not a file directly under .kodus/", ErrAuthoredFiles, f.Path)
		}
		if recipeFilePaths[f.Path] {
			return fmt.Errorf("%w: %s is a recipe path, not a build file", ErrAuthoredFiles, f.Path)
		}
		if seen[f.Path] {
			return fmt.Errorf("%w: %s is listed twice", ErrAuthoredFiles, f.Path)
		}
		seen[f.Path] = true
		if len(f.Content) > MaxAuthoredFileBytes {
			return fmt.Errorf("%w: %s is larger than %d bytes", ErrAuthoredFiles, f.Path, MaxAuthoredFileBytes)
		}
		total += len(f.Content)
	}
	if total > MaxAuthoredFilesBytes {
		return fmt.Errorf("%w: the files are larger than %d bytes together", ErrAuthoredFiles, MaxAuthoredFilesBytes)
	}
	return nil
}

// refineRecipe mirrors ClaimRecipeSchema's refinements.
func refineRecipe(r *ClaimAcquireBodyRecipe) error {
	if r == nil || r.Files == nil {
		return nil
	}
	if len(r.Content) == 0 || string(r.Content) == "null" {
		return errors.New(authoredFilesNeedRecipe)
	}
	if err := CheckAuthoredFiles(r.Files); err != nil {
		return fmt.Errorf("recipe.files: %w", err)
	}
	return nil
}
