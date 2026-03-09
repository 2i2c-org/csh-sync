/**
 * sync-issue.js
 *
 * Shared logic for syncing a single GitHub issue to Asana.
 * Used by both sync-all.js (batch) and sync-to-asana.js (single-issue webhook).
 */

import { fetchProjectMetadata } from "./github-metadata.js";
import {
  buildAsanaTaskPayload,
  buildUpdatePayload,
  resolveSection,
  asanaConfig,
} from "./field-mapping.js";

export function isConfigured(value) {
  return value && typeof value === "string" && !value.startsWith("REPLACE");
}

export async function syncIssue(asana, githubToken, issueData) {
  // Fetch project board metadata
  let projectItem = null;
  try {
    projectItem = await fetchProjectMetadata(githubToken, issueData.nodeId);
  } catch (err) {
    console.warn(`  ⚠ Could not fetch project metadata: ${err.message}`);
  }

  // Check for existing Asana task
  const cfGid = asanaConfig.custom_fields.github_issue_url;
  let existingTask = null;

  if (isConfigured(cfGid)) {
    try {
      const matches = await asana.searchTasks(
        asanaConfig.workspace_gid,
        asanaConfig.project_gid,
        { [cfGid]: issueData.htmlUrl }
      );
      if (matches.length > 0) {
        existingTask = matches[0];
      }
    } catch (err) {
      console.warn(`  ⚠ Search failed: ${err.message}`);
    }
  }

  let task;

  if (existingTask) {
    const updatePayload = buildUpdatePayload(issueData, projectItem);
    task = await asana.updateTask(existingTask.gid, updatePayload);
  } else {
    const createPayload = buildAsanaTaskPayload(issueData, projectItem);
    task = await asana.createTask(createPayload);

    const sectionGid = resolveSection(issueData.milestone);
    if (sectionGid) {
      try {
        await asana.addTaskToSection(sectionGid, task.gid);
      } catch (err) {
        console.warn(`  ⚠ Could not move to section: ${err.message}`);
      }
    }
  }

  return { action: existingTask ? "updated" : "created", task };
}
