/**
 * sync-to-asana.js
 *
 * Main orchestrator for the CSH sync workflow.
 *
 * Flow:
 *   1. Parse issue data from environment variables (set by GitHub Actions)
 *   2. Fetch enriched project board metadata via GraphQL
 *   3. Check if an Asana task already exists (idempotency)
 *   4. Create or update the Asana task
 *   5. Post a comment on the GitHub issue with the Asana link
 */

import { createAsanaClient } from "./asana-client.js";
import { syncIssue } from "./sync-issue.js";
import { asanaConfig } from "./field-mapping.js";

// ---------------------------------------------------------------------------
// 1. Parse environment
// ---------------------------------------------------------------------------

function parseEnv() {
  const required = [
    "ASANA_ACCESS_TOKEN",
    "GITHUB_TOKEN",
    "ISSUE_NODE_ID",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_HTML_URL",
    "REPO_FULL_NAME",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  // Parse JSON fields safely
  let assignees = [];
  try {
    assignees = JSON.parse(process.env.ISSUE_ASSIGNEES || "[]");
  } catch {
    console.warn("Could not parse ISSUE_ASSIGNEES, using empty array");
  }

  let labels = [];
  try {
    labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
  } catch {
    console.warn("Could not parse ISSUE_LABELS, using empty array");
  }

  let milestone = null;
  try {
    const raw = process.env.ISSUE_MILESTONE;
    if (raw && raw !== "null") {
      milestone = JSON.parse(raw);
    }
  } catch {
    console.warn("Could not parse ISSUE_MILESTONE, using null");
  }

  return {
    asanaToken: process.env.ASANA_ACCESS_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    issueData: {
      nodeId: process.env.ISSUE_NODE_ID,
      number: process.env.ISSUE_NUMBER,
      title: process.env.ISSUE_TITLE,
      body: process.env.ISSUE_BODY || "",
      htmlUrl: process.env.ISSUE_HTML_URL,
      state: process.env.ISSUE_STATE || "open",
      assignees,
      labels,
      milestone,
      repoFullName: process.env.REPO_FULL_NAME,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Post a comment on the GitHub issue linking to the Asana task
// ---------------------------------------------------------------------------

async function postGitHubComment(githubToken, repoFullName, issueNumber, asanaTaskUrl) {
  const [owner, repo] = repoFullName.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

  const body = [
    `🔗 **Asana task created for Community Success Hours**`,
    ``,
    `This issue has been synced to Asana: ${asanaTaskUrl}`,
    ``,
    `_Automated by [csh-sync](https://github.com/2i2c-org/csh-sync)_`,
  ].join("\n");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`Warning: Could not post GitHub comment: ${response.status} ${errorText}`);
  } else {
    console.log("Posted Asana link as comment on GitHub issue");
  }
}

// ---------------------------------------------------------------------------
// 3. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== CSH Sync: GitHub → Asana ===\n");

  const eventAction = process.env.EVENT_ACTION || "unknown";
  console.log(`Trigger: issues.${eventAction}`);

  // Parse inputs
  const { asanaToken, githubToken, issueData } = parseEnv();
  console.log(`Issue: ${issueData.repoFullName}#${issueData.number} — "${issueData.title}"`);
  console.log(`State: ${issueData.state}`);
  // Initialize Asana client
  const asana = createAsanaClient(asanaToken);

  // Sync issue (fetch project metadata, check idempotency, create or update)
  console.log("\nSyncing issue to Asana...");
  const { action, task } = await syncIssue(asana, githubToken, issueData);
  console.log(`${action === "created" ? "Created" : "Updated"} task: ${task.gid}`);

  // Build the Asana task URL
  const asanaTaskUrl = `https://app.asana.com/0/${asanaConfig.project_gid}/${task.gid}`;
  console.log(`\nAsana task URL: ${asanaTaskUrl}`);

  // Post comment on GitHub issue (only for new tasks)
  if (action === "created") {
    console.log("\nPosting link on GitHub issue...");
    await postGitHubComment(
      githubToken,
      issueData.repoFullName,
      issueData.number,
      asanaTaskUrl
    );
  }

  console.log("\n=== Sync complete ===");
}

// Run
main().catch((err) => {
  console.error("\n❌ Sync failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});