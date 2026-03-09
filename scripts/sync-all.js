/**
 * sync-all.js
 *
 * Batch sync: finds all open issues with the CSH label across the
 * 2i2c-org organization and syncs each one to Asana.
 *
 * Used by:
 *   - Scheduled cron workflow (catch project board field changes)
 *   - Manual workflow_dispatch (on-demand re-sync)
 *
 * Unlike sync-to-asana.js (which processes a single issue from a webhook
 * event), this script queries GitHub's search API to discover issues.
 */

import { graphql } from "@octokit/graphql";
import { createAsanaClient } from "./asana-client.js";
import { syncIssue } from "./sync-issue.js";

// ---------------------------------------------------------------------------
// GitHub search: find all CSH-labeled issues
// ---------------------------------------------------------------------------

async function findCSHIssues(token, org) {
  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  const issues = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const result = await gql(
      `
      query ($searchQuery: String!, $cursor: String) {
        search(query: $searchQuery, type: ISSUE, first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ... on Issue {
              id
              number
              title
              body
              url
              state
              labels(first: 20) {
                nodes { name }
              }
              assignees(first: 10) {
                nodes { login }
              }
              milestone {
                title
                dueOn
              }
              repository {
                nameWithOwner
              }
            }
          }
        }
      }
    `,
      {
        searchQuery: `org:${org} label:CSH is:issue is:open`,
        cursor,
      }
    );

    const search = result.search;
    for (const node of search.nodes) {
      issues.push({
        nodeId: node.id,
        number: String(node.number),
        title: node.title,
        body: node.body || "",
        htmlUrl: node.url,
        state: node.state.toLowerCase(),
        labels: node.labels.nodes.map((l) => ({ name: l.name })),
        assignees: node.assignees.nodes.map((a) => ({ login: a.login })),
        milestone: node.milestone
          ? { title: node.milestone.title, due_on: node.milestone.dueOn }
          : null,
        repoFullName: node.repository.nameWithOwner,
      });
    }

    hasNextPage = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const asanaToken = process.env.ASANA_ACCESS_TOKEN;
  const org = process.env.GITHUB_ORG || "2i2c-org";

  if (!token || !asanaToken) {
    console.error("Missing GITHUB_TOKEN or ASANA_ACCESS_TOKEN");
    process.exit(1);
  }

  console.log(`=== CSH Batch Sync: ${org} → Asana ===\n`);

  // Discover all CSH-labeled issues
  console.log("🔍 Searching for open CSH-labeled issues...\n");
  const issues = await findCSHIssues(token, org);
  console.log(`Found ${issues.length} issue(s)\n`);

  if (issues.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  // Initialize Asana client
  const asana = createAsanaClient(asanaToken);

  // Sync each issue
  const results = { created: 0, updated: 0, failed: 0 };

  for (const issueData of issues) {
    const label = `${issueData.repoFullName}#${issueData.number}`;
    console.log(`Syncing: ${label} — "${issueData.title}"`);

    try {
      const { action, task } = await syncIssue(asana, token, issueData);
      console.log(`  ✅ ${action === "created" ? "Created" : "Updated"}: ${label} → task ${task.gid}`);
      results[action]++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      results.failed++;
    }

    // Small delay to respect Asana rate limits (150 req/min)
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n=== Batch sync complete ===`);
  console.log(`  Created: ${results.created}`);
  console.log(`  Updated: ${results.updated}`);
  console.log(`  Failed:  ${results.failed}`);

  if (results.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ Batch sync failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});