# CSH Sync: GitHub Issues → Asana Tasks

Automatically creates Asana tasks when a GitHub issue is labeled `CSH` (Community Success Hours) on any repo in the `2i2c-org` organization.

## How It Works

1. A contributor adds the `CSH` label to a GitHub issue
2. A GitHub Actions workflow fires on the `issues.labeled` event
3. The workflow fetches enriched metadata from the issue _and_ its GitHub Project board (via GraphQL)
4. It creates (or updates) a corresponding Asana task with mapped fields
5. It comments on the GitHub issue with a link to the new Asana task

## Repository Structure

```
csh-sync/                          # This repo (2i2c-org/csh-sync)
├── .github/
│   └── workflows/
│       └── csh-sync.yml           # Reusable workflow (workflow_call)
├── scripts/
│   ├── sync-to-asana.js           # Orchestrator: validate, fetch, create
│   ├── github-metadata.js         # GraphQL queries for project board fields
│   ├── asana-client.js            # Asana REST API wrapper
│   └── field-mapping.js           # GitHub → Asana field mapping logic
├── config/
│   ├── asana-config.json          # Asana project/field IDs
│   └── user-mapping.json          # GitHub username → Asana user GID
├── package.json
└── README.md
```

## Setup

### 1. Create this repo

Create `2i2c-org/csh-sync` and push this code.

### 2. Configure Asana

In your Asana CSH project, create custom fields that correspond to the GitHub board fields you want to sync. At minimum:

| Custom Field Name   | Type          | Purpose                                     |
|---------------------|---------------|---------------------------------------------|
| `GitHub Issue URL`  | Text          | Canonical link back (also the idempotency key) |
| `GitHub Repo`       | Text          | Source repository name                       |
| `GitHub Labels`     | Text          | Comma-separated labels (minus CSH)           |
| `Status`            | Single-select | Mirrors GitHub board Status column           |
| `Priority`          | Single-select | Mirrors GitHub board Priority                |
| `Allocation`        | Single-select | Mirrors GitHub board Allocation              |
| `Unplanned`         | Single-select | Mirrors GitHub board Unplanned               |
| `Estimate`          | Number        | Story points / sizing from GitHub            |
| `Hours spent`       | Number        | Tracked hours from GitHub                    |
| `Iteration`         | Text          | Current iteration title from GitHub          |
| `Process`           | Text          | Process field from GitHub                    |
| `SoW`               | Text          | Statement of Work reference                  |

**Note:** Start date and End date from GitHub map to Asana's native `start_on` and `due_on` task fields — no custom fields needed for those.

Then update `config/asana-config.json` with the actual GIDs.

### 3. Set organization secrets

In the **2i2c-org** organization settings (Settings → Secrets and variables → Actions):

| Secret Name          | Value                                      |
|----------------------|--------------------------------------------|
| `ASANA_ACCESS_TOKEN` | Asana personal access token or service account token |
| `CSH_SYNC_PAT`       | GitHub PAT with `repo`, `project:read` scopes (needed for cross-repo GraphQL) |

### 4. Add caller workflows to each repo

In every repo that should participate in CSH sync, add a thin caller workflow:

```yaml
# .github/workflows/csh-sync-caller.yml
name: CSH Sync

on:
  issues:
    types: [labeled]

jobs:
  sync:
    uses: 2i2c-org/csh-sync/.github/workflows/csh-sync.yml@main
    secrets:
      ASANA_ACCESS_TOKEN: ${{ secrets.ASANA_ACCESS_TOKEN }}
      CSH_SYNC_PAT: ${{ secrets.CSH_SYNC_PAT }}
```

That's it — the caller is intentionally minimal. All logic lives in this central repo.

## Field Mapping

All fields from the **Product and Services** board (project #57) are synced:

| GitHub Project #57 Field | Type          | Asana Target                    |
|--------------------------|---------------|---------------------------------|
| Issue title              | (issue)       | Task name                       |
| Issue body (markdown)    | (issue)       | Task notes (HTML)               |
| Issue assignees          | (issue)       | Asana assignee (via user map)   |
| Issue URL                | (issue)       | Custom field: GitHub Issue URL  |
| Repository full name     | (issue)       | Custom field: GitHub Repo       |
| Labels (excluding CSH)   | (issue)       | Custom field: GitHub Labels     |
| **Status**               | Single-select | Custom field (enum mapping)     |
| **Priority**             | Single-select | Custom field (enum mapping)     |
| **Allocation**           | Single-select | Custom field (enum mapping)     |
| **Unplanned**            | Single-select | Custom field (enum mapping)     |
| **Estimate**             | Number        | Custom field (number)           |
| **Hours spent**          | Number        | Custom field (number)           |
| **Iteration**            | Iteration     | Custom field (text: title)      |
| **Start date**           | Date          | Asana `start_on`                |
| **End date**             | Date          | Asana `due_on`                  |
| **Process**              | Text          | Custom field (text)             |
| **SoW**                  | Text          | Custom field (text)             |
| Sub-issues progress      | (native)      | *Not synced (GitHub-only)*      |
| Milestone due date       | (issue)       | Asana `due_on` (fallback)       |

## Idempotency

Before creating a task, the script searches Asana for an existing task where `GitHub Issue URL` matches the issue's URL. If found, it updates the existing task instead of creating a duplicate. This means re-labeling or re-running the workflow is safe.

## Future: Bidirectional Sync

The return path (Asana → GitHub) is not implemented in this MVP. For now, use commit message conventions:

- Reference issues in commits: `Relates to #42` or `CSH: updates for 2i2c-org/infrastructure#42`
- GitHub will auto-link these on the issue timeline

When bidirectional sync is needed, the path is:
1. Register an Asana webhook on the CSH project
2. Deploy a lightweight receiver (Cloud Function / Cloudflare Worker)
3. On task completion in Asana, post a comment or close the GitHub issue via API
