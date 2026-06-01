# Kody Code Review - Quick Cheatsheet

**Kody** is your AI code reviewer that automatically analyzes pull requests and provides actionable suggestions.

## 🚀 When Kody Reviews Automatically

- ✅ PR opened
- ✅ New commits pushed (depending on cadence settings)
- ✅ Manual trigger: comment `@kody start-review`

## 👀 When Kody Skips

- No new commits since last review
- Only merge commits (no effective changes)
- All files ignored by patterns (e.g., `.lock`, `.env`)
- PR exceeds file limit (200 reviewable files)
- PR is in draft mode (if configured)

## 📊 Status Reactions (GitHub/GitLab)

Kody shows live status with emoji reactions:

- 🚀 **Processing** - Review in progress
- 🎉 **Completed** - Review finished, check comments
- 👀 **Skipped** - No review needed (see reasons above)
- 😕 **Error** - Something went wrong, try `@kody start-review` again

## 🎯 Quick Actions

**Need a review?** Comment: `@kody start-review`

**Review not showing?** Check:
1. PR has code changes (not just docs/images)
2. Branch is in scope (default branch or configured base branches)
3. Files aren't all ignored
4. Automated reviews enabled (or use manual trigger)

## 💡 Tips for Better Reviews

- **Keep PRs focused** - Smaller diffs = better review quality
- **Link specs/tickets** - Helps Kody understand context
- **Re-run after fixes** - Use `@kody start-review` after addressing feedback

## 📚 Learn More

- [Full Documentation](https://docs.kodus.io)
- [Troubleshooting Guide](https://docs.kodus.io/how_to_use/en/code_review/troubleshooting)
- [Configuration Guide](https://docs.kodus.io/how_to_use/en/code_review/configs/general)

---

**Need help?** Join our [Discord community](https://discord.gg/TFZBRk9fT6) or check the docs above.





