# Azure DevOps Companion for VS Code

Review and manage Azure DevOps pull requests and pipelines directly in VS Code — without leaving your editor.

## Features

### Pull Requests
- 📋 **View Pull Requests** — See all active PRs grouped by category (yours, needs review, all)
- ➕ **Create Pull Requests** — Open a form to create a PR from the current branch
- 🔍 **Code Review** — Browse changed files in a tabbed UI (Files / Overview / Comments) and open native VS Code diff editor for each file
- 💬 **View & Add Comments** — Read comment threads and add your own
- 🔀 **Checkout Branch** — Switch to a PR's source branch with one click
- ✅ **Approve PRs** — Approve pull requests inline
- 🤖 **Review with Copilot** — One-click PR review: checks out the branch, opens changed files, and sends a customizable review prompt to Copilot Chat. Choose between Agent mode (applies fixes), Ask mode (read-only), or a plain prompt. Prompt editor with default bug/typo/error detection template built into the PR dashboard.

### Pipelines
- 🚀 **Pipeline Dashboard** — Full webview dashboard with pipeline cards, build history, stage/job/task timeline with collapsible sections
- 📊 **Progress Bars** — Visual progress indicators per stage and overall, color-coded by status (green/red/blue), auto-refresh every 10s while running
- ▶️ **Run Pipelines** — Queue new pipeline runs with branch selection directly from the dashboard
- 📋 **Pipeline Sidebar** — See recent pipeline runs at a glance in the Activity Bar

### General
- 🔎 **Project Filtering** — Filter PRs and pipelines by project using the filter icon in each sidebar view title, or the project dropdown in the pipeline dashboard
- 🧩 **Work Items Linked to Code** — See assigned work, detect work items from the current branch, and surface linked work items inside PR overview
- ⚡ **Quick Task Updates** — Create task work items, change state, assign to yourself, and add notes without leaving VS Code
- 🔒 **Secure Authentication** — Microsoft Entra sign-in via VS Code account session

## Security

Authentication uses VS Code's built-in **Microsoft** authentication provider and requests an Azure DevOps access token via Microsoft Entra ID.

- Tokens are managed by VS Code's account/session infrastructure.
- The extension stores only a lightweight local "disconnected" flag in `SecretStorage`.
- No PAT is required.

## Setup

1. Install the extension
2. Open the Azure DevOps Companion view in the Activity Bar
3. Click **Configure Organization and Sign In**
4. Enter:
   - Your organization URL (`https://dev.azure.com/your-org`)
   - Your project name
5. Complete the Microsoft sign-in prompt shown by VS Code

### Authentication Notes

- This extension now uses delegated OAuth access through Microsoft Entra.
- PAT restrictions in Azure DevOps organizations do not block this sign-in flow.
- If your tenant enforces conditional access, sign-in may require MFA/device compliance.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `azureDevOpsPR.organizationUrl` | `""` | Azure DevOps org URL |
| `azureDevOpsPR.project` | `""` | Default project name |
| `azureDevOpsPR.defaultRepository` | `""` | Default repo (auto-detected if empty) |
| `azureDevOpsPR.autoRefreshInterval` | `300` | Refresh interval in seconds (min: 60) |
| `azureDevOpsPR.showDrafts` | `true` | Show draft PRs |

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Press F5 in VS Code to launch Extension Development Host

# Package
npm run package
```

## Project Structure

```
src/
├── extension.ts               # Entry point, command registration
├── api/
│   └── azureDevOpsApi.ts      # Azure DevOps REST API wrapper
├── providers/
│   ├── pullRequestProvider.ts # PR tree view (with project filter)
│   ├── pipelineProvider.ts    # Pipeline tree view (with project filter)
│   └── workItemProvider.ts    # My Work tree view for assigned and branch-linked work items
├── views/
│   ├── prDetailPanel.ts       # PR detail webview: tabbed Files/Overview/Comments, native diff editor
│   ├── createPRPanel.ts       # Create PR webview form
│   └── pipelineDashboardPanel.ts # Pipeline dashboard: cards, history, timeline, progress bars
└── utils/
    ├── authManager.ts         # Microsoft Entra auth session management
    ├── gitHelper.ts           # Git operations (branch, checkout, remote)
    └── workItemHelper.ts      # Work item ID inference from branches and PR text
```

## Contributing

PRs welcome! Please keep security in mind:
- Never log or expose access tokens
- Always use `SecretStorage` for extension secrets
- Validate all inputs before sending to the API

## License

MIT
