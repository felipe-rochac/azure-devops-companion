# Changelog

All notable changes to this extension will be documented here.

## [0.2.0]

### Added
- **Pipeline Dashboard** — Full webview with project selector, pipeline cards grid, build history table, collapsible stage/job/task timeline
- **Pipeline Progress Bars** — Overall and per-stage progress indicators, color-coded (succeeded/failed/in-progress), auto-refresh every 10s for running builds
- **Run Pipelines** — Queue new pipeline runs with branch selection from the dashboard
- **PR Code Review** — Tabbed detail panel (Files / Overview / Comments) with changed file list and native VS Code diff editor via `ado-pr` URI scheme
- **Project Filtering** — Filter PRs and pipelines by project from the sidebar view title bar (filter icon) or the dashboard project dropdown
- Retry logic with exponential backoff on all API calls (2 retries, timeout 30s, retry on 5xx/429)

## [0.1.0] - Initial Release

### Added
- View active pull requests grouped by category (mine, needs review, all)
- Create pull requests from the current branch via a form
- View PR details: description, reviewers, comment threads
- Add comments to pull requests
- Approve pull requests inline
- Checkout PR source branch with one click
- View recent pipeline / CI runs
- Secure PAT authentication via VS Code SecretStorage (OS keychain)
- Auto-refresh configurable interval
- Draft PR support (toggle in settings)
- Auto-detect repository from git remote URL
