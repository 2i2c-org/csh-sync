/**
 * sync-to-asana.js
 *
 * Main orchestrator for the CSH sync workflow.
 *
 * Flow:
 *   1. Parse issue data from environment variables (set by GitHub Actions)
 *   2. Fetch enriched project board metadata via GraphQL
 *   3. If closing: enforce Hours Spent is set (reopen + comment if not)
 *   4. Check if an Asana task already exists (idempotency)
 *   5. Create or update the Asana task
 *   6. Post a comment on the GitHub issue with the Asana link (new tasks only)
 */

import { fetchProjectMetadata } from "./github-metadata.js";
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
// GitHub helpers
// ---------------------------------------------------------------------------

async function githubRequest(token, method, path, body = null) {
  const url = `https://api.github.com${path}`;
  const options = {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    console.warn(`Warning: GitHub API ${method} ${path} → ${response.status}: ${text}`);
  }
  return response;
}

async function postIssueComment(token, repoFullName, issueNumber, body) {
  const [owner, repo] = repoFullName.split("/");
  await githubRequest(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body }
  );
}

async function reopenIssue(token, repoFullName, issueNumber) {
  const [owner, repo] = repoFullName.split("/");
  await githubRequest(
    token,
    "PATCH",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    { state: "open" }
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== CSH Sync: GitHub → Asana ===\n");

  const eventAction = process.env.EVENT_ACTION || "unknown";
  console.log(`Trigger: issues.${eventAction}`);

  const { asanaToken, githubToken, issueData } = parseEnv();
  console.log(`Issue: ${issueData.repoFullName}#${issueData.number} — "${issueData.title}"`);
  console.log(`State: ${issueData.state}`);

  // Fetch project board metadata (needed both for the close guard and for Asana sync)
  console.log("\nFetching project board metadata...");
  let projectItem = null;
  try {
    projectItem = await fetchProjectMetadata(githubToken, issueData.nodeId);
  } catch (err) {
    console.warn(`Warning: Could not fetch project metadata: ${err.message}`);
  }

  // ---------------------------------------------------------------------------
  // Close guard: enforce Hours Spent is set before allowing a close
  // ---------------------------------------------------------------------------
  if (eventAction === "closed") {
    if (projectItem && projectItem.fields["Hours spent"] === undefined) {
      console.log("\n⚠ Issue closed without Hours Spent set — reopening...");

      await reopenIssue(githubToken, issueData.repoFullName, issueData.number);
      console.log("Reopened issue.");

      const boardUrl = projectItem.projectUrl;
      const comment = [
        `⚠️ **This issue cannot be closed until Hours Spent is recorded**`,
        ``,
        `The **Hours Spent** field on the [${projectItem.projectTitle} project board](${boardUrl}) has not been filled in.`,
        ``,
        `Please update **Hours Spent** in the project board, then re-close this issue.`,
        ``,
        `_This issue was automatically reopened by [csh-sync](https://github.com/2i2c-org/csh-sync)_`,
      ].join("\n");

      await postIssueComment(githubToken, issueData.repoFullName, issueData.number, comment);
      console.log("Posted explanation comment.");

      console.log("\n=== Close blocked: Hours Spent not set ===");
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Sync to Asana (pass pre-fetched projectItem to avoid a second GraphQL call)
  // ---------------------------------------------------------------------------
  const asana = createAsanaClient(asanaToken);

  console.log("\nSyncing issue to Asana...");
  const { action, task } = await syncIssue(asana, githubToken, issueData, projectItem);
  console.log(`${action === "created" ? "Created" : "Updated"} task: ${task.gid}`);

  const asanaTaskUrl = `https://app.asana.com/0/${asanaConfig.project_gid}/${task.gid}`;
  console.log(`\nAsana task URL: ${asanaTaskUrl}`);

  // Post Asana link comment on GitHub (only for newly created tasks)
  if (action === "created") {
    console.log("\nPosting link on GitHub issue...");
    const body = [
      `🔗 **Asana task created for Community Success Hours**`,
      ``,
      `This issue has been synced to Asana: ${asanaTaskUrl}`,
      ``,
      `_Automated by [csh-sync](https://github.com/2i2c-org/csh-sync)_`,
    ].join("\n");
    await postIssueComment(githubToken, issueData.repoFullName, issueData.number, body);
  }

  console.log("\n=== Sync complete ===");
}

main().catch((err) => {
  console.error("\n❌ Sync failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
