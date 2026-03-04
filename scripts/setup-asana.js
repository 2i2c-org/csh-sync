#!/usr/bin/env node

/**
 * setup-asana.js
 *
 * Discovery and validation script for the CSH Sync integration.
 *
 * What it does:
 *   1. Connects to Asana using your access token
 *   2. Lists your workspaces so you can identify the right one
 *   3. Lists projects in that workspace to find the CSH project
 *   4. Reads all custom fields on the project
 *   5. Validates that required fields exist with the correct types
 *   6. Reads all sections in the project
 *   7. Generates a populated asana-config.json with real GIDs
 *
 * Usage:
 *   export ASANA_ACCESS_TOKEN="your-token-here"
 *
 *   # Interactive: walks you through workspace/project selection
 *   node scripts/setup-asana.js
 *
 *   # Direct: skip prompts if you already know the project GID
 *   node scripts/setup-asana.js --project-gid 1234567890
 */

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Asana API helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://app.asana.com/api/1.0";

async function asanaGet(token, path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana API ${res.status}: ${body}`);
  }

  const json = await res.json();
  return json.data;
}

async function getWorkspaces(token) {
  return asanaGet(token, "/workspaces?opt_fields=gid,name");
}

async function getProjects(token, workspaceGid) {
  return asanaGet(
    token,
    `/projects?workspace=${workspaceGid}&opt_fields=gid,name,archived&limit=100`
  );
}

async function getProjectCustomFields(token, projectGid) {
  // custom_field_settings gives us the fields attached to this project,
  // including their full definitions with enum options
  return asanaGet(
    token,
    `/projects/${projectGid}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled`
  );
}

async function getSections(token, projectGid) {
  return asanaGet(
    token,
    `/projects/${projectGid}/sections?opt_fields=gid,name`
  );
}

async function getUsers(token, workspaceGid) {
  return asanaGet(
    token,
    `/users?workspace=${workspaceGid}&opt_fields=gid,name,email`
  );
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function createPrompt() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // prompts to stderr so stdout stays clean for piping
  });

  return {
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });
    },
    close() {
      rl.close();
    },
  };
}

function printTable(rows, columns) {
  // Calculate column widths (pass row index to value callbacks)
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((r, ri) => String(col.value(r, ri)).length))
  );

  const header = columns.map((c, i) => c.header.padEnd(widths[i])).join("  ");
  const divider = widths.map((w) => "─".repeat(w)).join("──");

  console.error(header);
  console.error(divider);
  for (let ri = 0; ri < rows.length; ri++) {
    const line = columns
      .map((c, ci) => String(c.value(rows[ri], ri)).padEnd(widths[ci]))
      .join("  ");
    console.error(line);
  }
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

/**
 * The fields we expect to find on the Asana project, keyed by the
 * config key we use in asana-config.json.
 *
 * `required: true` means the sync will fail without it.
 * `asana_type` is what we expect the Asana field type to be.
 * `match` is a case-insensitive name matching strategy.
 */
const EXPECTED_FIELDS = [
  // Metadata fields (created specifically for this integration)
  {
    configKey: "github_issue_url",
    matchNames: ["github issue url", "github issue", "github url"],
    expectedType: "text",
    required: true,
    purpose: "Idempotency key — links Asana task back to GitHub issue",
  },
  {
    configKey: "github_repo",
    matchNames: ["github repo", "github repository", "repo"],
    expectedType: "text",
    required: false,
    purpose: "Source repository name",
  },
  {
    configKey: "github_labels",
    matchNames: ["github labels", "labels"],
    expectedType: "text",
    required: false,
    purpose: "Issue labels (comma-separated)",
  },

  // Fields mirroring GitHub Project #57
  {
    configKey: "status",
    matchNames: ["status"],
    expectedType: "enum",
    required: false,
    purpose: "Board status column from GitHub",
  },
  {
    configKey: "priority",
    matchNames: ["priority"],
    expectedType: "enum",
    required: false,
    purpose: "Priority from GitHub board",
  },
  {
    configKey: "allocation",
    matchNames: ["allocation"],
    expectedType: "enum",
    required: false,
    purpose: "Allocation from GitHub board",
  },
  {
    configKey: "unplanned",
    matchNames: ["unplanned"],
    expectedType: "enum",
    required: false,
    purpose: "Unplanned flag from GitHub board",
  },
  {
    configKey: "estimate",
    matchNames: ["estimate", "story points", "points"],
    expectedType: "number",
    required: false,
    purpose: "Estimate/story points from GitHub board",
  },
  {
    configKey: "hours_spent",
    matchNames: ["hours spent", "hours", "time spent"],
    expectedType: "number",
    required: false,
    purpose: "Hours spent from GitHub board",
  },
  {
    configKey: "iteration",
    matchNames: ["iteration", "sprint"],
    expectedType: "text",
    required: false,
    purpose: "Iteration title from GitHub board (synced as text)",
  },
  {
    configKey: "process",
    matchNames: ["process"],
    expectedType: "text",
    required: false,
    purpose: "Process field from GitHub board",
  },
  {
    configKey: "sow",
    matchNames: ["sow", "statement of work"],
    expectedType: "text",
    required: false,
    purpose: "Statement of Work from GitHub board",
  },
];

/**
 * Match Asana custom fields to expected fields by name (case-insensitive).
 * Returns a report of matches, mismatches, and missing fields.
 */
function validateAndMatchFields(asanaFields, expectedFields) {
  const results = {
    matched: [],    // { expected, asanaField, typeMatch }
    missing: [],    // expected fields with no Asana match
    extra: [],      // Asana fields not matched to anything
    warnings: [],   // type mismatches etc.
  };

  const unmatchedAsana = new Set(asanaFields.map((f) => f.gid));

  for (const expected of expectedFields) {
    // Try to find a matching Asana field by name
    const match = asanaFields.find((af) =>
      expected.matchNames.some(
        (name) => af.name.toLowerCase() === name.toLowerCase()
      )
    );

    if (!match) {
      results.missing.push(expected);
      continue;
    }

    unmatchedAsana.delete(match.gid);

    // Check type compatibility
    const asanaType = match.resource_subtype; // "text", "number", "enum"
    const typeMatch = asanaType === expected.expectedType;

    if (!typeMatch) {
      results.warnings.push(
        `Field "${match.name}" (${expected.configKey}): expected type "${expected.expectedType}" but found "${asanaType}". ` +
        (asanaType === "text"
          ? "This will work — values will be written as strings."
          : `This may cause errors.`)
      );
    }

    results.matched.push({ expected, asanaField: match, typeMatch });
  }

  // Remaining unmatched Asana fields
  results.extra = asanaFields.filter((f) => unmatchedAsana.has(f.gid));

  return results;
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

function generateConfig(workspaceGid, projectGid, matchResults, sections) {
  const config = {
    workspace_gid: workspaceGid,
    project_gid: projectGid,

    github_project: {
      org: "2i2c-org",
      project_number: 57,
      project_name: "Product and Services",
    },

    custom_fields: {
      start_date: null,
      end_date: null,
    },

    enum_mappings: {},

    sections: {},
  };

  // Populate custom_fields from matched fields
  for (const { expected, asanaField } of matchResults.matched) {
    config.custom_fields[expected.configKey] = asanaField.gid;

    // If it's an enum field, populate the enum mapping with all options
    if (asanaField.resource_subtype === "enum" && asanaField.enum_options) {
      const enabledOptions = asanaField.enum_options.filter((o) => o.enabled);
      const mapping = {};
      for (const opt of enabledOptions) {
        mapping[opt.name] = opt.gid;
      }
      config.enum_mappings[expected.configKey] = mapping;
    }
  }

  // Missing fields get null
  for (const expected of matchResults.missing) {
    config.custom_fields[expected.configKey] = null;
  }

  // Sections
  for (const section of sections) {
    config.sections[section.name] = section.gid;
  }
  if (sections.length > 0) {
    config.sections.default = sections[0].gid;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) {
    console.error("Error: ASANA_ACCESS_TOKEN environment variable is not set.");
    console.error("");
    console.error("  export ASANA_ACCESS_TOKEN='your-token-here'");
    console.error("  node scripts/setup-asana.js");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const projectGidArg = args.includes("--project-gid")
    ? args[args.indexOf("--project-gid") + 1]
    : null;

  const prompt = createPrompt();

  try {
    // -----------------------------------------------------------------------
    // Step 1: Workspace
    // -----------------------------------------------------------------------
    console.error("\n🔍 Fetching workspaces...\n");
    const workspaces = await getWorkspaces(token);

    if (workspaces.length === 0) {
      console.error("No workspaces found. Check your access token.");
      process.exit(1);
    }

    let workspace;
    if (workspaces.length === 1) {
      workspace = workspaces[0];
      console.error(`Using workspace: ${workspace.name} (${workspace.gid})\n`);
    } else {
      printTable(workspaces, [
        { header: "#", value: (_, i) => i + 1 },
        { header: "Name", value: (w) => w.name },
        { header: "GID", value: (w) => w.gid },
      ]);
      const choice = await prompt.ask("\nSelect workspace number: ");
      workspace = workspaces[parseInt(choice, 10) - 1];
      if (!workspace) {
        console.error("Invalid selection.");
        process.exit(1);
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Project
    // -----------------------------------------------------------------------
    let projectGid;

    if (projectGidArg) {
      projectGid = projectGidArg;
      console.error(`Using provided project GID: ${projectGid}\n`);
    } else {
      console.error("🔍 Fetching projects...\n");
      const projects = await getProjects(token, workspace.gid);
      const active = projects.filter((p) => !p.archived);

      printTable(active, [
        { header: "#", value: (_, i) => i + 1 },
        { header: "Name", value: (p) => p.name },
        { header: "GID", value: (p) => p.gid },
      ]);

      const choice = await prompt.ask(
        "\nSelect the CSH project number (or paste a GID): "
      );

      // Allow either index or direct GID
      if (/^\d{10,}$/.test(choice)) {
        projectGid = choice;
      } else {
        const project = active[parseInt(choice, 10) - 1];
        if (!project) {
          console.error("Invalid selection.");
          process.exit(1);
        }
        projectGid = project.gid;
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Fetch custom fields
    // -----------------------------------------------------------------------
    console.error("🔍 Fetching custom fields on the project...\n");
    const fieldSettings = await getProjectCustomFields(token, projectGid);
    const asanaFields = fieldSettings.map((fs) => fs.custom_field);

    console.error(`Found ${asanaFields.length} custom field(s):\n`);
    printTable(asanaFields, [
      { header: "Name", value: (f) => f.name },
      { header: "Type", value: (f) => f.resource_subtype },
      { header: "GID", value: (f) => f.gid },
      {
        header: "Enum Options",
        value: (f) =>
          f.resource_subtype === "enum" && f.enum_options
            ? f.enum_options
                .filter((o) => o.enabled)
                .map((o) => o.name)
                .join(", ")
            : "—",
      },
    ]);

    // -----------------------------------------------------------------------
    // Step 4: Validate fields
    // -----------------------------------------------------------------------
    console.error("\n\n📋 Validating fields against expected schema...\n");
    const validation = validateAndMatchFields(asanaFields, EXPECTED_FIELDS);

    // Matched fields
    if (validation.matched.length > 0) {
      console.error(`✅ Matched (${validation.matched.length}):`);
      for (const { expected, asanaField, typeMatch } of validation.matched) {
        const typeNote = typeMatch ? "" : ` ⚠️  (type: ${asanaField.resource_subtype}, expected: ${expected.expectedType})`;
        console.error(
          `   ${expected.configKey} → "${asanaField.name}" (${asanaField.gid})${typeNote}`
        );
      }
    }

    // Missing fields
    if (validation.missing.length > 0) {
      console.error(`\n⚠️  Missing (${validation.missing.length}):`);
      for (const expected of validation.missing) {
        const req = expected.required ? " [REQUIRED]" : " [optional]";
        console.error(
          `   ${expected.configKey}${req} — ${expected.purpose}`
        );
        console.error(
          `     Create a ${expected.expectedType} field named: "${expected.matchNames[0]}"`
        );
      }
    }

    // Warnings
    if (validation.warnings.length > 0) {
      console.error(`\n⚠️  Warnings:`);
      for (const w of validation.warnings) {
        console.error(`   ${w}`);
      }
    }

    // Extra fields on the project (informational)
    if (validation.extra.length > 0) {
      console.error(`\nℹ️  Other fields on this project (not mapped):`);
      for (const f of validation.extra) {
        console.error(`   "${f.name}" (${f.resource_subtype}, ${f.gid})`);
      }
    }

    // Check for required missing fields
    const requiredMissing = validation.missing.filter((e) => e.required);
    if (requiredMissing.length > 0) {
      console.error(
        `\n❌ ${requiredMissing.length} required field(s) missing. ` +
        `Create them in Asana and re-run this script.`
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Fetch sections
    // -----------------------------------------------------------------------
    console.error("\n🔍 Fetching sections...\n");
    const sections = await getSections(token, projectGid);

    if (sections.length > 0) {
      printTable(sections, [
        { header: "Name", value: (s) => s.name },
        { header: "GID", value: (s) => s.gid },
      ]);
    } else {
      console.error("   No sections found.");
    }

    // -----------------------------------------------------------------------
    // Step 6: Fetch users (for user-mapping.json)
    // -----------------------------------------------------------------------
    console.error("\n🔍 Fetching workspace users...\n");
    let users = [];
    try {
      users = await getUsers(token, workspace.gid);
      if (users.length > 0) {
        printTable(users.slice(0, 50), [
          { header: "Name", value: (u) => u.name },
          { header: "Email", value: (u) => u.email || "—" },
          { header: "GID", value: (u) => u.gid },
        ]);
        if (users.length > 50) {
          console.error(`   ... and ${users.length - 50} more`);
        }
      }
    } catch (err) {
      console.error(`   Could not fetch users: ${err.message}`);
    }

    // -----------------------------------------------------------------------
    // Step 7: Generate config
    // -----------------------------------------------------------------------
    console.error("\n\n📝 Generating config files...\n");

    const config = generateConfig(
      workspace.gid,
      projectGid,
      validation,
      sections
    );

    // Write asana-config.json
    const configPath = new URL("../config/asana-config.json", import.meta.url);
    const configJson = JSON.stringify(config, null, 2);
    await writeFile(configPath, configJson + "\n");
    console.error(`✅ Written: config/asana-config.json`);

    // Write user-mapping.json (template with discovered users)
    const userMap = { users: {} };
    for (const u of users) {
      // Use email prefix as a guess for GitHub username
      const emailPrefix = u.email ? u.email.split("@")[0] : null;
      userMap.users[`GITHUB_USERNAME_FOR_${u.name.replace(/\s+/g, "_")}`] = u.gid;
      if (emailPrefix) {
        userMap.users[`_hint_${u.name}`] = `email: ${u.email}, gid: ${u.gid}`;
      }
    }
    const userMapPath = new URL("../config/user-mapping.json", import.meta.url);
    await writeFile(userMapPath, JSON.stringify(userMap, null, 2) + "\n");
    console.error(`✅ Written: config/user-mapping.json (edit GitHub usernames)`);

    // Print the config to stdout for easy review
    console.error("\n─── Generated asana-config.json ───\n");
    console.log(configJson);

    // Summary
    console.error("\n\n🏁 Setup complete!\n");
    console.error("Next steps:");
    console.error("  1. Review config/asana-config.json");
    if (requiredMissing.length > 0) {
      console.error(
        `  2. Create the ${requiredMissing.length} missing required field(s) in Asana, then re-run this script`
      );
    }
    console.error(
      "  2. Edit config/user-mapping.json — replace GITHUB_USERNAME keys with actual GitHub logins"
    );
    console.error(
      "  3. If you added enum fields to Asana whose option names differ from GitHub's,"
    );
    console.error(
      "     edit the enum_mappings in asana-config.json to use the GitHub-side names as keys"
    );
    console.error(
      "  4. Set org-level secrets (ASANA_ACCESS_TOKEN, CSH_SYNC_PAT) and deploy\n"
    );
  } finally {
    prompt.close();
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
