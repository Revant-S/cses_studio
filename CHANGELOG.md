# Changelog

## [Unreleased]

### Fixed

- Submissions failing with `connect ETIMEDOUT` even when the site was reachable.
  Node only gave each address 250ms to connect, which is not enough for cses.fi.

### Added

- Practice contests: pick topics, get a timed set, watch the clock in the status
  bar. Problems marked for revision come first, then ones that took several tries.
- Contest state survives a window reload.
- Failed attempts are counted per problem, not just timestamped.
- Settings `cses.contest.problems` and `cses.contest.minutes`.
- Keybindings `Ctrl+Alt+C` and `Ctrl+Alt+N`.

## [0.1.0] - Initial release

### Added

- Problem explorer with categories, solve status and an unsolved-only filter.
- Scraper for the full problem set: 400 problems across 18 categories, with
  limits, constraints and samples.
- Local cache under `~/.cses-studio/cache/`, refreshed on request only.
- Statement webview with bundled KaTeX and copyable samples.
- Workspace generator with configurable C++ and Python templates.
- Sample runner with compile caching and line diffs.
- Custom test runner reporting stdout, stderr, exit code and time.
- Login with session storage in the OS keychain and silent re-login.
- Submission with runtime form discovery and verdict polling.
- Progress tracking, synced from the account.
- Quick-pick search over title, id and category.
- Status bar showing sign-in state and progress.
