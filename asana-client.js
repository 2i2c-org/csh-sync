/**
 * asana-client.js
 *
 * Thin wrapper around the Asana REST API.
 * Uses native fetch (Node 20+), no SDK dependency needed.
 */

const BASE_URL = "https://app.asana.com/api/1.0";

/**
 * Create an Asana API client bound to an access token.
 *
 * @param {string} accessToken - Asana PAT or service account token
 * @returns {Object} Client with search, create, update methods
 */
export function createAsanaClient(accessToken) {
  async function request(method, path, body = null) {
    const url = `${BASE_URL}${path}`;
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Asana API error: ${response.status} ${response.statusText}\n${errorBody}`
      );
    }

    // 204 No Content (e.g., delete) returns no body
    if (response.status === 204) return null;

    const json = await response.json();
    return json.data;
  }

  return {
    /**
     * Search for tasks in a workspace by custom field value.
     * Used for idempotency — find existing task by GitHub Issue URL.
     *
     * @param {string} workspaceGid
     * @param {string} projectGid
     * @param {Object} customFieldFilters - { fieldGid: value }
     * @returns {Promise<Array>} Matching tasks
     */
    async searchTasks(workspaceGid, projectGid, customFieldFilters) {
      // Build search params
      // Asana search API uses: custom_fields.{gid}.value = "..."
      const params = new URLSearchParams();
      params.set("projects.any", projectGid);

      for (const [fieldGid, value] of Object.entries(customFieldFilters)) {
        params.set(`custom_fields.${fieldGid}.value`, value);
      }

      params.set("opt_fields", "gid,name,permalink_url,custom_fields");

      const result = await request(
        "GET",
        `/workspaces/${workspaceGid}/tasks/search?${params.toString()}`
      );

      return result || [];
    },

    /**
     * Create a new task in a project.
     *
     * @param {Object} taskData - Task creation payload
     * @returns {Promise<Object>} Created task
     */
    async createTask(taskData) {
      return request("POST", "/tasks", { data: taskData });
    },

    /**
     * Update an existing task.
     *
     * @param {string} taskGid - Task to update
     * @param {Object} taskData - Fields to update
     * @returns {Promise<Object>} Updated task
     */
    async updateTask(taskGid, taskData) {
      return request("PUT", `/tasks/${taskGid}`, { data: taskData });
    },

    /**
     * Add a task to a specific section within a project.
     *
     * @param {string} sectionGid
     * @param {string} taskGid
     */
    async addTaskToSection(sectionGid, taskGid) {
      return request("POST", `/sections/${sectionGid}/addTask`, {
        data: { task: taskGid },
      });
    },

    /**
     * Add a comment (story) to a task.
     *
     * @param {string} taskGid
     * @param {string} htmlText - HTML-formatted comment
     */
    async addComment(taskGid, htmlText) {
      return request("POST", `/tasks/${taskGid}/stories`, {
        data: { html_text: htmlText },
      });
    },
  };
}
