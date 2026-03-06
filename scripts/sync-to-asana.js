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

import { fetchProjectMetadata } from "./github-metadata.js";
import { createAsanaClient } from "./asana-client.js";
import {
  buildAsanaTaskPayload,
  buildUpdatePayload,
  resolveSection,
  asanaConfig,
} from "./field-mapping.js";

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
  // Fetch project board metadata via GraphQL (Product and Services #57)
  console.log("\nFetching GitHub Project #57 metadata...");
  let projectItem = null;
  try {
    projectItem = await fetchProjectMetadata(githubToken, issueData.nodeId);
    if (projectItem) {
      console.log(`Found on board: ${projectItem.projectTitle}`);
      const fieldNames = Object.keys(projectItem.fields);
      console.log(`  Fields populated: ${fieldNames.join(", ") || "none"}`);
      for (const [name, data] of Object.entries(projectItem.fields)) {
        const display = data.type === "iteration"
          ? `${data.value} (${data.startDate}, ${data.duration} days)`
          : data.value;
        console.log(`    ${name}: ${display}`);
      }
    } else {
      console.log("Issue is not on the Product and Services board (#57)");
    }
  } catch (err) {
    // Non-fatal: issue might not be on the project board
    console.warn(`Warning: Could not fetch project metadata: ${err.message}`);
    console.warn("Continuing without project board fields...");
  }

  // Initialize Asana client
  const asana = createAsanaClient(asanaToken);

  // Idempotency check: search for existing task
  console.log("\nChecking for existing Asana task...");
  const cfGid = asanaConfig.custom_fields.github_issue_url;
  let existingTask = null;

  if (cfGid && !cfGid.startsWith("REPLACE")) {
    try {
      const matches = await asana.searchTasks(
        asanaConfig.workspace_gid,
        asanaConfig.project_gid,
        { [cfGid]: issueData.htmlUrl }
      );
      if (matches.length > 0) {
        existingTask = matches[0];
        console.log(`Found existing task: ${existingTask.gid} — "${existingTask.name}"`);
      }
    } catch (err) {
      console.warn(`Warning: Search failed, will create new task: ${err.message}`);
    }
  } else {
    console.warn("GitHub Issue URL custom field not configured — skipping idempotency check");
  }

  let task;

  if (existingTask) {
    // Update existing task
    console.log("\nUpdating existing Asana task...");
    const updatePayload = buildUpdatePayload(issueData, projectItem);
    task = await asana.updateTask(existingTask.gid, updatePayload);
    console.log(`Updated task: ${task.gid}`);
  } else {
    // Create new task
    console.log("\nCreating new Asana task...");
    const createPayload = buildAsanaTaskPayload(issueData, projectItem);
    task = await asana.createTask(createPayload);
    console.log(`Created task: ${task.gid} — "${task.name}"`);

    // Optionally move to a section
    const sectionGid = resolveSection(issueData.milestone);
    if (sectionGid) {
      try {
        await asana.addTaskToSection(sectionGid, task.gid);
        console.log(`Moved task to section: ${sectionGid}`);
      } catch (err) {
        console.warn(`Warning: Could not move task to section: ${err.message}`);
      }
    }
  }

  // Build the Asana task URL
  const asanaTaskUrl = `https://app.asana.com/0/${asanaConfig.project_gid}/${task.gid}`;
  console.log(`\nAsana task URL: ${asanaTaskUrl}`);

  // Post comment on GitHub issue (only for new tasks)
  if (!existingTask) {
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