/**
 * github-metadata.js
 *
 * Fetches enriched metadata from the "Product and Services" GitHub Project
 * board (2i2c-org, project #57) via the GraphQL API.
 *
 * Custom fields on the board:
 *   Single-select: Status, Allocation, Unplanned, Priority
 *   Number:        Estimate, Hours spent
 *   Iteration:     Iteration
 *   Date:          Start date, End date
 *   Text:          Process, SoW
 *   (read-only):   Sub-issues progress (GitHub-native, not synced)
 */

import { graphql } from "@octokit/graphql";

// The "Product and Services" board
const TARGET_PROJECT_NUMBER = 57;
const TARGET_ORG = "2i2c-org";

/**
 * Create an authenticated GraphQL client.
 * Uses CSH_SYNC_PAT because the default GITHUB_TOKEN doesn't have
 * cross-repo project:read scope.
 */
function createClient(token) {
  return graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
}

/**
 * Fetch project board metadata for an issue from the Product and Services
 * board (project #57). If the issue is on multiple boards, only the
 * fields from #57 are returned.
 *
 * @param {string} token - GitHub PAT
 * @param {string} issueNodeId - The GraphQL node_id of the issue
 * @returns {Promise<Object|null>} Parsed project item with field values, or null
 */
export async function fetchProjectMetadata(token, issueNodeId) {
  const gql = createClient(token);

  const result = await gql(
    `
    query ($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          projectItems(first: 10) {
            nodes {
              id
              project {
                title
                number
                url
              }
              fieldValues(first: 30) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    __typename
                    name
                    field {
                      ... on ProjectV2SingleSelectField {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    __typename
                    text
                    field {
                      ... on ProjectV2Field {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    __typename
                    number
                    field {
                      ... on ProjectV2Field {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    __typename
                    date
                    field {
                      ... on ProjectV2Field {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldIterationValue {
                    __typename
                    title
                    startDate
                    duration
                    field {
                      ... on ProjectV2IterationField {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `,
    { issueId: issueNodeId }
  );

  const projectItems = result?.node?.projectItems?.nodes || [];

  // Filter to only the Product and Services board (#57)
  const targetItem = projectItems.find(
    (item) => item.project.number === TARGET_PROJECT_NUMBER
  );

  if (!targetItem) {
    console.log(
      `Issue is not on the "${TARGET_ORG}" project #${TARGET_PROJECT_NUMBER}. ` +
      `Found projects: ${projectItems.map((i) => `#${i.project.number} "${i.project.title}"`).join(", ") || "none"}`
    );
    return null;
  }

  return {
    projectTitle: targetItem.project.title,
    projectNumber: targetItem.project.number,
    projectUrl: targetItem.project.url,
    fields: parseFieldValues(targetItem.fieldValues.nodes),
  };
}

/**
 * Parse the heterogeneous field value nodes into a clean key-value map.
 *
 * Expected fields from the Product and Services board:
 *   Status        → single_select
 *   Allocation    → single_select
 *   Unplanned     → single_select
 *   Priority      → single_select
 *   Estimate      → number
 *   Hours spent   → number
 *   Iteration     → iteration (title + startDate + duration)
 *   Start date    → date
 *   End date      → date
 *   Process       → text
 *   SoW           → text
 *
 * @param {Array} fieldNodes - Raw GraphQL field value nodes
 * @returns {Object} Map of field name → { type, value, ... }
 */
function parseFieldValues(fieldNodes) {
  const fields = {};

  for (const node of fieldNodes) {
    // Skip empty nodes (GraphQL returns empty objects for unset fields)
    if (!node.__typename || !node.field?.name) continue;

    const fieldName = node.field.name;

    switch (node.__typename) {
      case "ProjectV2ItemFieldSingleSelectValue":
        fields[fieldName] = { type: "single_select", value: node.name };
        break;
      case "ProjectV2ItemFieldTextValue":
        fields[fieldName] = { type: "text", value: node.text };
        break;
      case "ProjectV2ItemFieldNumberValue":
        fields[fieldName] = { type: "number", value: node.number };
        break;
      case "ProjectV2ItemFieldDateValue":
        fields[fieldName] = { type: "date", value: node.date };
        break;
      case "ProjectV2ItemFieldIterationValue":
        fields[fieldName] = {
          type: "iteration",
          value: node.title,
          startDate: node.startDate,
          duration: node.duration,
        };
        break;
    }
  }

  return fields;
}
