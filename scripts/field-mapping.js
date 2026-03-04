/**
 * field-mapping.js
 *
 * Transforms GitHub issue data + Project #57 "Product and Services"
 * board metadata into Asana task creation/update payloads.
 *
 * GitHub Project #57 custom fields:
 *   Single-select: Status, Allocation, Unplanned, Priority
 *   Number:        Estimate, Hours spent
 *   Iteration:     Iteration
 *   Date:          Start date, End date
 *   Text:          Process, SoW
 *   (skipped):     Sub-issues progress (read-only, GitHub-native)
 */

import { readFile } from "node:fs/promises";

// Load config files
const asanaConfig = JSON.parse(
  await readFile(new URL("../config/asana-config.json", import.meta.url))
);
const userMapping = JSON.parse(
  await readFile(new URL("../config/user-mapping.json", import.meta.url))
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a config value is a real GID (not a placeholder or null) */
function isConfigured(value) {
  return value && typeof value === "string" && !value.startsWith("REPLACE");
}

/**
 * Strip markdown/HTML to plain text for the Asana `notes` field.
 *
 * Using plain text avoids all of Asana's strict XML validation issues.
 * GitHub issue bodies often contain HTML comments, template tags, and
 * other markup that is extremely hard to sanitize into Asana-valid XML.
 */
function markdownToPlainText(markdown) {
  if (!markdown) return "";
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")           // HTML comments
    .replace(/<[^>]+>/g, "")                    // HTML tags
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // [text](url) → text (url)
    .replace(/^#{1,6}\s+/gm, "")               // heading markers
    .replace(/\*\*([^*]+)\*\*/g, "$1")          // **bold** → bold
    .replace(/\*([^*]+)\*/g, "$1")              // *italic* → italic
    .replace(/__([^_]+)__/g, "$1")              // __bold__ → bold
    .replace(/_([^_]+)_/g, "$1")                // _italic_ → italic
    .replace(/~~([^~]+)~~/g, "$1")              // ~~strike~~ → strike
    .replace(/`([^`]+)`/g, "$1")                // `code` → code
    .replace(/^[-*+]\s+/gm, "• ")              // list items → bullet
    .replace(/^\d+\.\s+/gm, (m) => m)           // numbered lists (keep as-is)
    .replace(/^>\s+/gm, "  ")                   // blockquotes → indent
    .replace(/---+/g, "———")                    // horizontal rules
    .replace(/\n{3,}/g, "\n\n")                 // collapse excess newlines
    .trim();
}

/**
 * Resolve GitHub assignees to Asana user GIDs.
 * Returns the first matched assignee (Asana tasks have a single assignee).
 */
function resolveAssignee(assignees) {
  if (!assignees || assignees.length === 0) return null;
  for (const assignee of assignees) {
    const asanaGid = userMapping.users[assignee.login];
    if (isConfigured(asanaGid)) return asanaGid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field mapping: GitHub Project #57 → Asana custom fields
// ---------------------------------------------------------------------------

/**
 * Map a single-select GitHub field to an Asana custom field value.
 *
 * If enum_mappings exist for this field, looks up the Asana enum option GID.
 * Otherwise, returns the raw string (for text-type Asana fields).
 *
 * @param {string} fieldKey - Config key (e.g., "status", "priority")
 * @param {string} githubValue - The option name from GitHub
 * @returns {string|null} Asana field value (enum GID or string)
 */
function mapSingleSelect(fieldKey, githubValue) {
  if (!githubValue) return null;

  const enumMap = asanaConfig.enum_mappings?.[fieldKey];
  if (enumMap && enumMap[githubValue]) {
    const gid = enumMap[githubValue];
    return isConfigured(gid) ? gid : null;
  }

  // No enum mapping — pass through as string (for text-type Asana fields)
  return githubValue;
}

/**
 * Extract and map all Project #57 board fields into Asana custom_fields
 * and task-level date properties.
 *
 * @param {Object|null} projectItem - Parsed project item from fetchProjectMetadata()
 * @returns {{ customFields: Object, startOn: string|null, dueOn: string|null }}
 */
function mapProjectFields(projectItem) {
  const customFields = {};
  let startOn = null;
  let dueOn = null;

  if (!projectItem) return { customFields, startOn, dueOn };

  const fields = projectItem.fields;
  const cf = asanaConfig.custom_fields;

  // --- Single-select fields ---
  const selectFields = [
    { github: "Status",     configKey: "status" },
    { github: "Priority",   configKey: "priority" },
    { github: "Allocation", configKey: "allocation" },
    { github: "Unplanned",  configKey: "unplanned" },
  ];

  for (const { github, configKey } of selectFields) {
    const fieldData = fields[github];
    if (fieldData?.type === "single_select" && isConfigured(cf[configKey])) {
      const mapped = mapSingleSelect(configKey, fieldData.value);
      if (mapped) {
        customFields[cf[configKey]] = mapped;
      }
    }
  }

  // --- Number fields ---
  const numberFields = [
    { github: "Estimate",    configKey: "estimate" },
    { github: "Hours spent", configKey: "hours_spent" },
  ];

  for (const { github, configKey } of numberFields) {
    const fieldData = fields[github];
    if (fieldData?.type === "number" && isConfigured(cf[configKey])) {
      customFields[cf[configKey]] = fieldData.value;
    }
  }

  // --- Iteration (synced as text: iteration title) ---
  const iterField = fields["Iteration"];
  if (iterField?.type === "iteration" && isConfigured(cf.iteration)) {
    customFields[cf.iteration] = iterField.value; // title string
  }

  // --- Text fields ---
  const textFields = [
    { github: "Process", configKey: "process" },
    { github: "SoW",     configKey: "sow" },
  ];

  for (const { github, configKey } of textFields) {
    const fieldData = fields[github];
    if (fieldData?.type === "text" && isConfigured(cf[configKey])) {
      customFields[cf[configKey]] = fieldData.value;
    }
  }

  // --- Date fields → Asana task-level dates (not custom fields) ---
  const startField = fields["Start date"];
  if (startField?.type === "date" && startField.value) {
    startOn = startField.value; // ISO date string: "2025-03-15"
  }

  const endField = fields["End date"];
  if (endField?.type === "date" && endField.value) {
    dueOn = endField.value;
  }

  return { customFields, startOn, dueOn };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an Asana task payload from GitHub issue data and Project #57 metadata.
 *
 * @param {Object} issueData - Parsed issue data from environment variables
 * @param {Object|null} projectItem - Project V2 metadata from GraphQL (single board)
 * @returns {Object} Asana task creation payload
 */
export function buildAsanaTaskPayload(issueData, projectItem) {
  const {
    title,
    body,
    htmlUrl,
    assignees,
    labels,
    milestone,
    repoFullName,
  } = issueData;

  // Filter out the CSH label
  const otherLabels = (labels || [])
    .map((l) => l.name)
    .filter((name) => name !== "CSH");

  // Map all project board fields
  const { customFields, startOn, dueOn } = mapProjectFields(projectItem);

  // Add metadata custom fields (linkage/tracking)
  const cf = asanaConfig.custom_fields;
  if (isConfigured(cf.github_issue_url)) {
    customFields[cf.github_issue_url] = htmlUrl;
  }
  if (isConfigured(cf.github_repo)) {
    customFields[cf.github_repo] = repoFullName;
  }
  if (isConfigured(cf.github_labels)) {
    customFields[cf.github_labels] = otherLabels.join(", ");
  }

  // Build description: issue body + metadata footer
  const metadataFooter = [
    `\n---`,
    `**Source:** [${repoFullName}#${issueData.number}](${htmlUrl})`,
    projectItem
      ? `**Project Board:** ${projectItem.projectTitle}`
      : null,
    otherLabels.length > 0
      ? `**Labels:** ${otherLabels.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const fullBody = (body || "") + "\n" + metadataFooter;

  // Use plain text notes — Asana's html_notes requires strict XML and
  // GitHub issue bodies contain too much unpredictable markup to sanitize reliably
  const payload = {
    name: title,
    notes: markdownToPlainText(fullBody),
    projects: [asanaConfig.project_gid],
    custom_fields: customFields,
  };

  // Assignee
  const assigneeGid = resolveAssignee(assignees);
  if (assigneeGid) {
    payload.assignee = assigneeGid;
  }

  // Dates: prefer project board dates, fall back to milestone
  if (startOn) {
    payload.start_on = startOn;
  }
  if (dueOn) {
    payload.due_on = dueOn;
  } else if (milestone?.due_on) {
    payload.due_on = milestone.due_on;
  }

  return payload;
}

/**
 * Determine which Asana section to place the task in.
 */
export function resolveSection(milestone) {
  if (milestone?.title && asanaConfig.sections[milestone.title]) {
    const gid = asanaConfig.sections[milestone.title];
    if (isConfigured(gid)) return gid;
  }
  const defaultGid = asanaConfig.sections?.default;
  if (isConfigured(defaultGid)) return defaultGid;
  return null;
}

/**
 * Build a payload for updating an existing task.
 * Includes all mapped fields except the project assignment.
 */
export function buildUpdatePayload(issueData, projectItem) {
  const full = buildAsanaTaskPayload(issueData, projectItem);
  const { projects, ...updateFields } = full;
  return updateFields;
}

export { asanaConfig };
