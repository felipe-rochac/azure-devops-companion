## [1.2.2] - 2026-04-29
### Added
- Pipelines: triggered and completed dates shown in tree item descriptions and tooltips
- Pull Requests: created date shown in tree item descriptions and tooltips
- Work Items: last updated date in descriptions, created and updated dates in tooltips
- Comprehensive debug logging in PR detail panel (Output panel + webview error banners)

### Fixed
- **All PR dashboard buttons broken** — a `\n` escape in the webview template literal produced literal newlines inside a JS string, causing a silent parse error that disabled all script execution

## [1.2.1] - 2026-04-28
### Added
- **Review with Copilot**: one-click PR review that checks out the branch, opens changed files, and sends a focused review prompt to Copilot Chat
- Customizable review prompt: editable textarea in the PR dashboard with a default bug/error/typo-only prompt
- Mode selector: choose Agent (can apply fixes), Ask (@workspace, read-only), or None (just open chat)
- Prompt is always copied to clipboard as a fallback if Copilot Chat doesn't auto-populate

### Fixed
- Review with Copilot button staying disabled after cancelling the confirmation dialog
- Copilot Chat not receiving the review prompt in certain VS Code versions

## [1.1.4] - 2026-04-21
### Added
- Pull Requests view: status filter and clear-status-filter actions in the view toolbar
- Pipelines view: status filter and clear-status-filter actions in the view toolbar
- Active filter note rows in PR and Pipeline trees while filters are applied

# Changelog

All notable changes to this extension will be documented here.

## [1.1.3] - 2026-04-21

### Added
- Work Items view: Filter by Status toolbar button — multi-select QuickPick to show only chosen statuses
- Work Items view: Clear Status Filter toolbar button — one-click reset
- Active filter label row displayed in the tree when a status filter is set

## [1.1.2] - 2026-04-20

### Fixed
- Create PR panel branches being replaced seconds after open by branches from the wrong repository
- Changing the Repository dropdown now correctly reloads branches for the selected repo
- Pre-selects the repo matching `azureDevOpsPR.defaultRepository` setting instead of always defaulting to first repo

## [1.1.1] - 2026-04-20

### Fixed
- Resolved deleted pull request files showing as `unknown` in the PR Files tab by using Azure DevOps server-side path metadata

### Changed
- Updated repository metadata to the `azure-devops-companion` GitHub URL

## [1.0.0] - 2026-04-17

### Added
- Full PR review workflow in VS Code: open PR details, approve PRs, inline comments, thread reply/resolve/reactivate
- Rich PR comment rendering for HTML and markdown-like content, including code/suggestion blocks
- Pipeline dashboard improvements with timeline hierarchy, running-state auto-refresh, and quick queue/run actions
- Open-in-browser fallback URL builders for PRs and builds when Azure DevOps links are incomplete
- Workspace auto-detection for Azure DevOps project/repository from git remote
- User setting `azureDevOpsPR.autoDetectFromWorkspace` (default: `true`)

### Changed
- Hardened command activation and PAT configuration flow reliability
- Improved pipeline Recent Runs retrieval ordering to better surface currently running builds
- Updated packaging to include required runtime dependencies for reliable extension activation

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
