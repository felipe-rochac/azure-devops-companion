## [1.5.0] - 2026-05-26
### Added
- **Deploy from build**: 🚀 button on succeeded build rows to trigger a release directly from a completed build, with release definition selection
- **Auto-deploy on build completion**: checkbox on running build timelines to automatically trigger a deployment when the build succeeds
- **Environment selection for auto-deploy**: choose which release environment (e.g., Dev, QA, Prod) to deploy to — other environments are set to manual so only the selected one auto-deploys
- Release definition and environment dropdowns appear inline in the timeline view when auto-deploy is enabled
- `getReleaseDefinitionsForBuild` API method to find release definitions linked to a build pipeline

## [1.4.1] - 2026-05-25
### Added
- **Copy Image Name** button on pipeline run rows and pipeline cards (uses `containerImageTemplate` setting)
- **Image dropdown on releases**: "Version / Image" field now shows a dropdown of recent build image names instead of a text input (when `containerImageTemplate` is configured)
- Deployment branch defaults to the **current workspace branch** when creating a release

### Fixed
- **Starred/favorite pipelines not persisting** across sessions — `globalState` was not being passed to the Pipeline Dashboard panel

## [1.4.0] - 2026-05-22
### Added
- **Started / Finished date columns** in the pipeline builds table with formatted timestamps and full-date tooltips
- Duration column in pipeline build runs

## [1.3.9] - 2026-05-18
### Added
- **Silent token refresh**: automatically refreshes expired OAuth tokens without re-prompting
- Interactive token re-authentication fallback when silent refresh fails

### Fixed
- **Branch dropdown showing stale/inactive branches** — now filters to branches with commit activity in the last 6 months

## [1.3.7] - 2026-05-10
### Added
- **YAML runtime parameters**: automatically parses `parameters:` from pipeline YAML files and renders them as form controls (text, checkbox, radio, dropdown)
- Support for classic pipeline `processParameters` inputs
- Pipeline parameter types: boolean (checkbox), pickList (dropdown), radio (≤5 options), and free-text
- `PipelineParameterMetadata` API for fetching variable overrides and template parameters

## [1.3.6] - 2026-05-04
### Added
- **Microsoft Entra (OAuth) authentication** — replaces PAT-based auth with VS Code's built-in Microsoft auth provider
- **Release management**: view release definitions, recent releases, and create new releases with artifact/branch overrides
- **Favorite pipelines**: star/unstar pipelines with favorites shown first (grouped or flat view)
- **Run pipeline with parameters**: queue builds with branch selection, variable overrides, and template parameter inputs
- **Pipeline view modes**: flat view and grouped-by-path view with collapsible groups
- Release environment status badges (succeeded, in-progress, rejected, not-started)
- Pipeline search/filter box in the dashboard header

### Changed
- Authentication flow migrated from PAT input box to Microsoft Entra OAuth sign-in
- API connection now uses OAuth bearer tokens managed by VS Code auth provider

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
