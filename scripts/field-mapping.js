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
import { marked } from "marked";

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
 * Asana-supported HTML tags (must be valid XML — closed, balanced, no attributes
 * except on <a> tags). Reference: https://developers.asana.com/docs/rich-text
 */
const ASANA_ALLOWED_TAGS = new Set([
  "body",
  "strong", "em", "u", "s",
  "code", "pre",
  "h1", "h2", "h3",
  "ol", "ul", "li",
  "blockquote",
  "br",
  "hr",
  "a",
  "img",
]);

/**
 * Sanitize HTML to only contain Asana-supported tags as valid XML.
 *
 * Strategy:
 *   1. Convert markdown → HTML via marked
 *   2. Strip HTML comments
 *   3. Remove unsupported tags (keep their text content)
 *   4. Remove attributes from all tags except <a> (keep href only)
 *   5. Convert <br> to self-closing <br />
 *   6. Ensure <img> tags are self-closing
 *   7. Wrap in <body>
 *
 * If anything still fails, fall back to plain text.
 */
function markdownToAsanaHtml(markdown) {
  if (!markdown) return "<body></body>";

  try {
    let html = marked.parse(markdown, { breaks: true });

    // Strip HTML comments (<!-- ... -->)  including multiline
    html = html.replace(/<!--[\s\S]*?-->/g, "");

    // Strip <input>, <details>, <summary> and other GitHub-flavored tags
    // that marked might pass through from the source markdown
    html = html.replace(/<\/?(input|details|summary|div|span|table|thead|tbody|tr|td|th|dd|dl|dt|abbr|sup|sub|mark|ins|del|small|big|center|font|section|article|aside|nav|header|footer|main|figure|figcaption|picture|source|video|audio|iframe|embed|object|param|map|area|canvas|svg|path|rect|circle|line|polyline|polygon|text|g|defs|symbol|use)[^>]*>/gi, "");

    // Remove attributes from all tags except <a>
    // First, handle <a> tags: keep only href
    html = html.replace(/<a\s+[^>]*?href\s*=\s*"([^"]*)"[^>]*>/gi, '<a href="$1">');
    // Handle <a> tags with single-quoted href
    html = html.replace(/<a\s+[^>]*?href\s*=\s*'([^']*)'[^>]*>/gi, '<a href="$1">');

    // Remove attributes from all other opening tags
    html = html.replace(/<((?!a\s|\/)[a-z][a-z0-9]*)\s+[^>]*>/gi, "<$1>");

    // Convert self-closing tags: <br>, <br/>, <br /> → <br />
    html = html.replace(/<br\s*\/?>/gi, "<br />");

    // Convert <hr>, <hr/>, <hr /> → <hr />
    html = html.replace(/<hr\s*\/?>/gi, "<hr />");

    // Ensure <img> tags are self-closing (remove any that snuck through without being stripped)
    html = html.replace(/<img[^>]*>/gi, "");

    // Remove any remaining tags not in the allowed set
    html = html.replace(/<\/?([a-z][a-z0-9]*)[^>]*>/gi, (match, tagName) => {
      const lower = tagName.toLowerCase();
      if (ASANA_ALLOWED_TAGS.has(lower)) return match;
      return ""; // strip unsupported tag
    });

    // Escape any stray ampersands that aren't part of entities
    html = html.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;");

    // Escape stray < and > that aren't part of tags
    // (This is tricky — we only want to escape angle brackets that aren't valid tags)
    // Simple approach: try to parse, and if it fails, fall back to plain text

    const result = `<body>${html}</body>`;

    // Quick XML validity check: count opening vs closing tags
    // If it's grossly unbalanced, fall back to plain text
    const openTags = (result.match(/<[a-z][^>]*[^/]>/gi) || []).length;
    const closeTags = (result.match(/<\/[a-z][^>]*>/gi) || []).length;
    const selfClosing = (result.match(/<[a-z][^>]*\/>/gi) || []).length;

    // Allow some slack (body tag counts as 1 open + 1 close)
    if (Math.abs(openTags - closeTags) > 5) {
      console.warn("HTML tag balance check failed, falling back to plain text notes");
      return null; // signal to use plain text
    }

    return result;
  } catch (err) {
    console.warn(`Markdown conversion failed: ${err.message}, using plain text`);
    return null; // signal to use plain text
  }
}

/**
 * Strip all HTML/markdown to plain text for the Asana `notes` field.
 */
function markdownToPlainText(markdown) {
  if (!markdown) return "";
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")     // HTML comments
    .replace(/<[^>]+>/g, "")              // HTML tags
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/[*_~`#]+/g, "")            // markdown formatting chars
    .replace(/\n{3,}/g, "\n\n")          // collapse excess newlines
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

  // Assemble the payload
  // Try HTML first; if sanitization fails, fall back to plain text
  const htmlNotes = markdownToAsanaHtml(fullBody);

  const payload = {
    name: title,
    projects: [asanaConfig.project_gid],
    custom_fields: customFields,
  };

  if (htmlNotes) {
    payload.html_notes = htmlNotes;
  } else {
    // Plain text fallback
    payload.notes = markdownToPlainText(fullBody);
  }

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
