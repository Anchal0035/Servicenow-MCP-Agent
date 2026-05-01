import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────
const SN_INSTANCE = process.env.SN_INSTANCE;
const SN_USER = process.env.SN_USER;
const SN_PASS = process.env.SN_PASS;

if (!SN_INSTANCE || !SN_USER || !SN_PASS) {
  console.error("❌ Missing required env vars: SN_INSTANCE, SN_USER, SN_PASS");
  process.exit(1);
}

const SN_BASE_URL = SN_INSTANCE.startsWith('http') ? SN_INSTANCE : `https://${SN_INSTANCE}`;

const snClient = axios.create({
  baseURL: SN_BASE_URL,
  auth: { username: SN_USER, password: SN_PASS },
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

const server = new Server(
  { name: "servicenow-agent-direct", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
async function getSysId(table, query) {
  const response = await snClient.get(`/api/now/table/${table}`, {
    params: { sysparm_query: query, sysparm_fields: "sys_id", sysparm_limit: 20 }
  });
  const results = response.data.result;
  if (!results || results.length === 0) {
    throw new Error(`Record not found in ${table} for query: ${query}`);
  }
  return results[0].sys_id;
}

async function getUserSysId(email) { return getSysId("sys_user", `email=${email}`); }
async function getGroupSysId(groupName) { return getSysId("sys_user_group", `name=${groupName}`); }
async function getCatalogItemSysId(itemName) { return getSysId("sc_cat_item", `name=${itemName}`); }
async function getServiceSysId(serviceName) { return getSysId("cmdb_ci_service", `name=${serviceName}`); }

async function createRequest(userSysId) {
  const response = await snClient.post("/api/now/table/sc_request", { requested_for: userSysId });
  return response.data.result.sys_id;
}

// Attach a local file to any ServiceNow record via the Attachment API
async function attachFileToRecord(tableName, recordSysId, filePath) {
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const fileName = path.basename(resolvedPath);
  const fileBuffer = fs.readFileSync(resolvedPath);
  const mimeType = guessMimeType(fileName);

  const response = await axios.post(
    `${SN_BASE_URL}/api/now/attachment/file`,
    fileBuffer,
    {
      auth: { username: SN_USER, password: SN_PASS },
      headers: {
        'Content-Type': mimeType,
        'Accept': 'application/json',
        'X-No-Response-Body': 'false'
      },
      params: {
        table_name: tableName,
        table_sys_id: recordSysId,
        file_name: fileName
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  return {
    fileName,
    attachmentSysId: response.data.result?.sys_id,
    size: fileBuffer.length
  };
}

// Guess MIME type from file extension
function guessMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.log': 'text/plain',
    '.md': 'text/markdown'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// Process an optional filePaths array and return a formatted result string
async function processAttachments(table, recordSysId, filePaths) {
  if (!filePaths || filePaths.length === 0) return "";

  const lines = ["\n\n**Attachments:**"];
  for (const filePath of filePaths) {
    try {
      const { fileName, size } = await attachFileToRecord(table, recordSysId, filePath);
      const sizeKB = (size / 1024).toFixed(1);
      lines.push(`  📎 ${fileName} (${sizeKB} KB) — attached`);
    } catch (e) {
      lines.push(`  ⚠️ ${path.basename(filePath)} — failed: ${e.message}`);
    }
  }
  return lines.join("\n");
}

// Detect ticket type from number prefix
function getTableFromNumber(ticketNumber) {
  const prefix = ticketNumber.toUpperCase();
  if (prefix.startsWith("RITM")) return { table: "sc_req_item", label: "RITM" };
  if (prefix.startsWith("CHG")) return { table: "change_request", label: "Change Request" };
  if (prefix.startsWith("INC")) return { table: "incident", label: "Incident" };
  if (prefix.startsWith("REQ")) return { table: "sc_request", label: "Request" };
  throw new Error(`Unknown ticket prefix for: ${ticketNumber}. Supported: RITM, CHG, INC, REQ`);
}

// ─────────────────────────────────────────
// LIST TOOLS
// ─────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [

      // ── CREATE RITM ──────────────────────────────────────────────────────────
      {
        name: "create_ritm",
        description: `Create a ServiceNow RITM (service request) ticket.
          STEP 1: Collect ALL required fields (openedBy, requestedFor, item, shortDescription, description, priority, assignmentGroup, contactType).
          INTELLIGENT RECOGNITION: Before calling this tool, use 'search_catalog_items' and 'search_assignment_groups' to verify and match the user's input. If there's no exact match or multiple matches exist, present the list of options to the user first. NEVER assume a catalog item name from previous conversations.
          MANDATORY: You MUST ask the user to provide a detailed 'description'. Do not generate this yourself.
          MANDATORY: You MUST ask the user to select a 'contactType' (Customer Portal, Phone, Email, Self-service). Do not default this.
          OPTIONAL: Ask if the user wants to attach any files (e.g. Postman collections, docs, screenshots). If yes, collect the full file path(s) and pass them in 'filePaths'.
          NOTE: 'shortDescription' must be a concise summary and NOT a duplicate of 'description'. If the user doesn't provide one, default it to the catalog item name but always show it in the summary, 'priority' defaults to 3 (Medium), 'requestedFor' defaults to 'openedBy'.
          STEP 2: Present a formatted SUMMARY TABLE of all collected details including the shortDescription and any attachments.
          STEP 3: WAIT for the user to explicitly say "YES" or "PROCEED" before calling this tool.`,
        inputSchema: {
          type: "object",
          properties: {
            openedBy: { type: "string", description: "Email of person raising the ticket" },
            requestedFor: { type: "string", description: "Email of the person who needs this service" },
            item: { type: "string", description: "Exact catalog item name e.g. Pivotal Cloud Foundry (PCF)" },
            shortDescription: { type: "string", description: "One line summary of the request" },
            description: { type: "string", description: "Full detailed description provided by the user" },
            priority: { type: "string", enum: ["1", "2", "3", "4"], description: "1=Critical, 2=High, 3=Medium, 4=Low" },
            assignmentGroup: { type: "string", description: "Team responsible" },
            contactType: { type: "string", enum: ["Customer Portal", "Phone", "Email", "Self-service"] },
            filePaths: { type: "array", items: { type: "string" }, description: "Optional list of absolute file paths to attach e.g. ['C:/Users/user/docs/collection.json']" }
          },
          required: ["openedBy", "requestedFor", "item", "description", "priority", "assignmentGroup", "contactType"]
        }
      },

      // ── CREATE CHANGE REQUEST ─────────────────────────────────────────────────
      {
        name: "create_change_request",
        description: `Create a ServiceNow Change Request ticket.
          STEP 1: Collect required fields (openedBy, shortDescription, description, assignmentGroup, service, plannedStart, plannedEnd).
          INTELLIGENT RECOGNITION: Before calling this tool, use 'search_assignment_groups' and 'search_services' to verify and match the user's input.
          MANDATORY: You MUST ask the user to provide a detailed 'description'. Do not generate this yourself.
          NOTE: 'priority' defaults to 3 (Medium), 'changeType' defaults to 'normal', and 'riskLevel' defaults to 'low'. Always show these in the summary, 'requestedFor' defaults to 'openedBy'.
          OPTIONAL: Ask if the user wants to attach any files (e.g. runbooks, change docs, diagrams). If yes, collect the full file path(s) and pass them in 'filePaths'.
          STEP 2: Present a formatted SUMMARY TABLE of all collected details including any attachments.
          STEP 3: WAIT for the user to explicitly say "YES" or "PROCEED" before calling this tool.`,
        inputSchema: {
          type: "object",
          properties: {
            openedBy: { type: "string", description: "Email of person raising the ticket" },
            shortDescription: { type: "string", description: "One line summary" },
            description: { type: "string", description: "Full details provided by the user" },
            priority: { type: "string", enum: ["1", "2", "3", "4"] },
            assignmentGroup: { type: "string", description: "Responsible team" },
            service: { type: "string", description: "Business service name" },
            changeType: { type: "string", enum: ["normal", "standard", "emergency"] },
            riskLevel: { type: "string", enum: ["low", "medium", "high"] },
            plannedStart: { type: "string", description: "YYYY-MM-DD HH:MM" },
            plannedEnd: { type: "string", description: "YYYY-MM-DD HH:MM" },
            filePaths: { type: "array", items: { type: "string" }, description: "Optional list of absolute file paths to attach e.g. ['C:/Users/user/docs/runbook.pdf']" }
          },
          required: ["openedBy", "shortDescription", "description", "assignmentGroup", "service", "plannedStart", "plannedEnd"]
        }
      },

      // ── GET TICKET STATUS ─────────────────────────────────────────────────────
      {
        name: "get_ticket_status",
        description: `Fetch the full details and current status of any ServiceNow ticket by its number.
          Supports RITM (RITM*), Change Request (CHG*), Incident (INC*), and Request (REQ*).
          Use this when the user asks: "What is the status of RITM1234567?" or "Show me details of CHG0012345".`,
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: { type: "string", description: "Full ticket number e.g. RITM1234567, CHG0012345, INC0098765" }
          },
          required: ["ticketNumber"]
        }
      },

      // ── UPDATE TICKET ─────────────────────────────────────────────────────────
      {
        name: "update_ticket",
        description: `Update one or more fields on an existing ServiceNow ticket.
          Supports RITM (RITM*), Change Request (CHG*), Incident (INC*).
          Common updatable fields: priority, assignmentGroup, shortDescription, description, state, riskLevel, plannedStart, plannedEnd.
          MANDATORY: Always confirm the ticket number and the fields to update with the user before calling this tool.
          STEP 1: Show user a summary of what will be changed.
          STEP 2: WAIT for explicit "YES" or "PROCEED" before calling.`,
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: { type: "string", description: "Full ticket number e.g. RITM1234567" },
            priority: { type: "string", enum: ["1", "2", "3", "4"], description: "1=Critical, 2=High, 3=Medium, 4=Low" },
            assignmentGroup: { type: "string", description: "New assignment group name" },
            shortDescription: { type: "string", description: "Updated short description" },
            description: { type: "string", description: "Updated full description" },
            state: { type: "string", description: "New state value e.g. 'In Progress', '-5' (pending), '1' (open)" },
            riskLevel: { type: "string", enum: ["low", "medium", "high"], description: "For Change tickets only" },
            plannedStart: { type: "string", description: "YYYY-MM-DD HH:MM — for Change tickets only" },
            plannedEnd: { type: "string", description: "YYYY-MM-DD HH:MM — for Change tickets only" }
          },
          required: ["ticketNumber"]
        }
      },

      // ── ADD COMMENT / WORK NOTE ───────────────────────────────────────────────
      {
        name: "add_comment",
        description: `Add a comment or work note to an existing ServiceNow ticket.
          - 'comment' = visible to the end user (customer-facing)
          - 'work_note' = internal note, only visible to agents
          Supports RITM (RITM*), Change Request (CHG*), Incident (INC*).
          Ask the user: the ticket number, the note text, and whether it should be a comment or work note.`,
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: { type: "string", description: "Full ticket number e.g. INC0098765" },
            text: { type: "string", description: "The comment or work note text" },
            type: { type: "string", enum: ["comment", "work_note"], description: "'comment' = customer visible, 'work_note' = internal only" }
          },
          required: ["ticketNumber", "text", "type"]
        }
      },

      // ── CANCEL / CLOSE TICKET ─────────────────────────────────────────────────
      {
        name: "close_ticket",
        description: `Cancel or close an existing ServiceNow ticket.
          Supports RITM (RITM*), Change Request (CHG*), Incident (INC*).
          MANDATORY: Always ask the user for a closing reason/note before calling this tool.
          MANDATORY: Confirm ticket number and action with the user.
          STEP 1: Show summary of what will be closed and the reason.
          STEP 2: WAIT for explicit "YES" or "PROCEED" before calling.`,
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: { type: "string", description: "Full ticket number e.g. RITM1234567" },
            action: { type: "string", enum: ["cancel", "close"], description: "'cancel' = cancelled state, 'close' = resolved/closed state" },
            closingReason: { type: "string", description: "Reason for cancelling or closing the ticket" }
          },
          required: ["ticketNumber", "action", "closingReason"]
        }
      },

      // ── ATTACH FILE ───────────────────────────────────────────────────────────
      {
        name: "attach_file",
        description: `Attach one or more local files to an existing ServiceNow ticket.
          Supports any ticket type: RITM (RITM*), Change (CHG*), Incident (INC*), Request (REQ*).
          Supported file types: PDF, DOCX, DOC, XLSX, XLS, PPTX, TXT, CSV, JSON, XML, ZIP, PNG, JPG, LOG, MD and more.
          Use this when the user says: "attach this file to RITM1234567" or "add my Postman collection to CHG0012345".
          Always confirm the ticket number and file path(s) with the user before calling.`,
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: { type: "string", description: "Full ticket number e.g. RITM1234567, CHG0012345, INC0098765" },
            filePaths: { type: "array", items: { type: "string" }, description: "List of absolute file paths on the user's machine e.g. ['C:/Users/user/docs/collection.json', 'C:/Users/user/docs/runbook.pdf']" }
          },
          required: ["ticketNumber", "filePaths"]
        }
      },

      // ── SEARCH TOOLS ─────────────────────────────────────────────────────────
      {
        name: "search_assignment_groups",
        description: "Search for assignment groups in ServiceNow using a keyword fuzzy search.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keyword for the group name" }
          },
          required: ["query"]
        }
      },
      {
        name: "search_catalog_items",
        description: "Search for catalog items in ServiceNow using a keyword fuzzy search.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keyword for the item name" }
          },
          required: ["query"]
        }
      },
      {
        name: "search_services",
        description: "Search for business services in ServiceNow using a keyword fuzzy search.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keyword for the service name" }
          },
          required: ["query"]
        }
      }

    ]
  };
});

// ─────────────────────────────────────────
// CALL TOOL
// ─────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {

    // ── CREATE RITM ────────────────────────────────────────────────────────────
    if (name === "create_ritm") {
      const userSysId = await getUserSysId(args.requestedFor);
      const groupSysId = await getGroupSysId(args.assignmentGroup);
      const catItemSysId = await getCatalogItemSysId(args.item);
      const reqSysId = await createRequest(userSysId);

      const response = await snClient.post("/api/now/table/sc_req_item", {
        request: reqSysId,
        cat_item: catItemSysId,
        short_description: args.shortDescription || args.item,
        description: args.description,
        assignment_group: groupSysId,
        priority: args.priority || "3",
        contact_type: args.contactType,
        requested_for: userSysId
      });

      const ticketNumber = response.data.result.number;
      const ticketSysId = response.data.result.sys_id;
      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=sc_req_item.do?sysparm_query=number=${ticketNumber}`;

      // Handle optional file attachments
      const attachmentResults = await processAttachments("sc_req_item", ticketSysId, args.filePaths);

      return {
        content: [{
          type: "text",
          text: `✅ RITM created successfully!\n\n**Ticket Number: [${ticketNumber}](${ticketUrl})**${attachmentResults}`
        }]
      };
    }

    // ── CREATE CHANGE REQUEST ──────────────────────────────────────────────────
    if (name === "create_change_request") {
      const groupSysId = await getGroupSysId(args.assignmentGroup);
      const serviceSysId = await getServiceSysId(args.service);

      const response = await snClient.post("/api/now/table/change_request", {
        short_description: args.shortDescription,
        description: args.description,
        assignment_group: groupSysId,
        business_service: serviceSysId,
        priority: args.priority || "3",
        type: args.changeType || "normal",
        risk: args.riskLevel || "low",
        start_date: args.plannedStart,
        end_date: args.plannedEnd
      });

      const ticketNumber = response.data.result.number;
      const ticketSysId = response.data.result.sys_id;
      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=change_request.do?sysparm_query=number=${ticketNumber}`;

      // Handle optional file attachments
      const attachmentResults = await processAttachments("change_request", ticketSysId, args.filePaths);

      return {
        content: [{
          type: "text",
          text: `✅ Change Request created successfully!\n\n**Ticket Number: [${ticketNumber}](${ticketUrl})**${attachmentResults}`
        }]
      };
    }

    // ── GET TICKET STATUS ──────────────────────────────────────────────────────
    if (name === "get_ticket_status") {
      const { table, label } = getTableFromNumber(args.ticketNumber);

      // Define common fields
      let fields = "number,short_description,description,state,priority,assignment_group,assigned_to,opened_by,opened_at,updated_on,sys_created_on,contact_type";

      // Add table-specific fields to avoid 400 errors (ServiceNow fails if invalid fields are requested)
      if (table === "change_request") {
        fields += ",risk,type";
      } else if (table === "sc_req_item") {
        fields += ",requested_for";
      } else if (table === "incident") {
        fields += ",caller_id";
      }

      const response = await snClient.get(`/api/now/table/${table}`, {
        params: {
          sysparm_query: `number=${args.ticketNumber}`,
          sysparm_fields: fields,
          sysparm_limit: 1,
          sysparm_display_value: true
        }
      });

      const results = response.data.result;
      if (!results || results.length === 0) {
        return { content: [{ type: "text", text: `❌ Ticket ${args.ticketNumber} not found.` }] };
      }

      const t = results[0];
      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=${table}.do?sysparm_query=number=${args.ticketNumber}`;

      const details = [
        `## ${label}: [${t.number}](${ticketUrl})`,
        `**Short Description:** ${t.short_description || "—"}`,
        `**State:** ${t.state || "—"}`,
        `**Priority:** ${t.priority || "—"}`,
        `**Assignment Group:** ${t.assignment_group || "—"}`,
        `**Assigned To:** ${t.assigned_to || "Unassigned"}`,
        `**Opened By:** ${t.opened_by || "—"}`,
        `**Opened At:** ${t.opened_at || t.sys_created_on || "—"}`,
        `**Last Updated:** ${t.updated_on || "—"}`,
        t.requested_for ? `**Requested For:** ${t.requested_for}` : null,
        t.caller_id ? `**Caller:** ${t.caller_id}` : null,
        t.risk ? `**Risk:** ${t.risk}` : null,
        t.type ? `**Change Type:** ${t.type}` : null,
        `\n**Description:**\n${t.description || "No description provided."}`
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: details }] };
    }

    // ── UPDATE TICKET ──────────────────────────────────────────────────────────
    if (name === "update_ticket") {
      const { table, label } = getTableFromNumber(args.ticketNumber);

      // Get sys_id of the ticket
      const ticketSysId = await getSysId(table, `number=${args.ticketNumber}`);

      // Build update payload — only include fields that were provided
      const payload = {};
      if (args.shortDescription) payload.short_description = args.shortDescription;
      if (args.description) payload.description = args.description;
      if (args.priority) payload.priority = args.priority;
      if (args.state) payload.state = args.state;
      if (args.plannedStart) payload.start_date = args.plannedStart;
      if (args.plannedEnd) payload.end_date = args.plannedEnd;
      if (args.riskLevel) payload.risk = args.riskLevel;

      // Assignment group needs sys_id lookup
      if (args.assignmentGroup) {
        payload.assignment_group = await getGroupSysId(args.assignmentGroup);
      }

      if (Object.keys(payload).length === 0) {
        return { content: [{ type: "text", text: "❌ No fields provided to update." }] };
      }

      await snClient.patch(`/api/now/table/${table}/${ticketSysId}`, payload);

      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=${table}.do?sysparm_query=number=${args.ticketNumber}`;
      const updatedFields = Object.keys(payload).join(", ");

      return {
        content: [{
          type: "text",
          text: `✅ ${label} **${args.ticketNumber}** updated successfully!\n\n**Fields updated:** ${updatedFields}\n\n[View Ticket](${ticketUrl})`
        }]
      };
    }

    // ── ADD COMMENT / WORK NOTE ────────────────────────────────────────────────
    if (name === "add_comment") {
      const { table, label } = getTableFromNumber(args.ticketNumber);
      const ticketSysId = await getSysId(table, `number=${args.ticketNumber}`);

      // ServiceNow uses 'comments' for customer-visible and 'work_notes' for internal
      const field = args.type === "work_note" ? "work_notes" : "comments";
      await snClient.patch(`/api/now/table/${table}/${ticketSysId}`, {
        [field]: args.text
      });

      const typeLabel = args.type === "work_note" ? "Work Note (internal)" : "Comment (customer visible)";
      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=${table}.do?sysparm_query=number=${args.ticketNumber}`;

      return {
        content: [{
          type: "text",
          text: `✅ ${typeLabel} added to **${args.ticketNumber}** successfully!\n\n[View Ticket](${ticketUrl})`
        }]
      };
    }

    // ── CANCEL / CLOSE TICKET ──────────────────────────────────────────────────
    if (name === "close_ticket") {
      const { table, label } = getTableFromNumber(args.ticketNumber);
      const ticketSysId = await getSysId(table, `number=${args.ticketNumber}`);

      // State codes differ by ticket type
      const stateMap = {
        sc_req_item: { cancel: "4", close: "3" },  // 4=Cancelled, 3=Closed Complete
        change_request: { cancel: "-4", close: "3" },  // -4=Cancelled, 3=Closed
        incident: { cancel: "8", close: "6" },  // 8=Cancelled, 6=Resolved
        sc_request: { cancel: "4", close: "3" }
      };

      const states = stateMap[table];
      if (!states) {
        return { content: [{ type: "text", text: `❌ Close/cancel not supported for ticket type: ${label}` }] };
      }

      const newState = states[args.action];
      const payload = {
        state: newState,
        work_notes: `Ticket ${args.action}d. Reason: ${args.closingReason}`
      };

      // Incidents also need close_code and close_notes
      if (table === "incident") {
        payload.close_code = args.action === "close" ? "Solved (Permanently)" : "Closed/Resolved by Caller";
        payload.close_notes = args.closingReason;
      }

      await snClient.patch(`/api/now/table/${table}/${ticketSysId}`, payload);

      const actionLabel = args.action === "cancel" ? "Cancelled" : "Closed";
      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=${table}.do?sysparm_query=number=${args.ticketNumber}`;

      return {
        content: [{
          type: "text",
          text: `✅ ${label} **${args.ticketNumber}** ${actionLabel} successfully!\n\n**Reason:** ${args.closingReason}\n\n[View Ticket](${ticketUrl})`
        }]
      };
    }

    // ── ATTACH FILE ────────────────────────────────────────────────────────────
    if (name === "attach_file") {
      const { table, label } = getTableFromNumber(args.ticketNumber);
      const ticketSysId = await getSysId(table, `number=${args.ticketNumber}`);
      const ticketUrl = `${SN_BASE_URL}/nav_to.do?uri=${table}.do?sysparm_query=number=${args.ticketNumber}`;

      if (!args.filePaths || args.filePaths.length === 0) {
        return { content: [{ type: "text", text: "❌ No file paths provided." }] };
      }

      const results = [];
      for (const filePath of args.filePaths) {
        try {
          const { fileName, size } = await attachFileToRecord(table, ticketSysId, filePath);
          const sizeKB = (size / 1024).toFixed(1);
          results.push(`  ✅ **${fileName}** (${sizeKB} KB) — attached successfully`);
        } catch (e) {
          results.push(`  ❌ **${path.basename(filePath)}** — ${e.message}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: `📎 Attachment results for **${args.ticketNumber}**:\n\n${results.join("\n")}\n\n[View Ticket](${ticketUrl})`
        }]
      };
    }

    // ── SEARCH ASSIGNMENT GROUPS ───────────────────────────────────────────────
    if (name === "search_assignment_groups") {
      const query = args.query ? `nameCONTAINS${args.query}` : "sys_idISNOTEMPTY";
      const response = await snClient.get("/api/now/table/sys_user_group", {
        params: { sysparm_query: query, sysparm_fields: "name,sys_id", sysparm_limit: 20 }
      });
      const results = response.data.result;
      if (!Array.isArray(results) || results.length === 0) {
        return { content: [{ type: "text", text: "No matching assignment groups found." }] };
      }
      return {
        content: [{
          type: "text",
          text: `Found ${results.length} matching groups:\n\n${results.map(g => `- ${g.name}`).join("\n")}`
        }]
      };
    }

    // ── SEARCH CATALOG ITEMS ───────────────────────────────────────────────────
    if (name === "search_catalog_items") {
      const query = args.query ? `nameCONTAINS${args.query}` : "active=true";
      const response = await snClient.get("/api/now/table/sc_cat_item", {
        params: { sysparm_query: query, sysparm_fields: "name,sys_id", sysparm_limit: 20 }
      });
      const results = response.data.result;
      if (!Array.isArray(results) || results.length === 0) {
        return { content: [{ type: "text", text: "No matching catalog items found." }] };
      }
      return {
        content: [{
          type: "text",
          text: `Found ${results.length} matching items:\n\n${results.map(i => `- ${i.name}`).join("\n")}`
        }]
      };
    }

    // ── SEARCH SERVICES ────────────────────────────────────────────────────────
    if (name === "search_services") {
      const query = args.query ? `nameCONTAINS${args.query}` : "sys_idISNOTEMPTY";
      const response = await snClient.get("/api/now/table/cmdb_ci_service", {
        params: { sysparm_query: query, sysparm_fields: "name,sys_id", sysparm_limit: 20 }
      });
      const results = response.data.result;
      if (!Array.isArray(results) || results.length === 0) {
        return { content: [{ type: "text", text: "No matching services found." }] };
      }
      return {
        content: [{
          type: "text",
          text: `Found ${results.length} matching services:\n\n${results.map(s => `- ${s.name}`).join("\n")}`
        }]
      };
    }

  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message || "Unknown error occurred";
    const errorDetail = error.response?.data?.error?.detail || "";
    const statusCode = error.response?.status ? ` (HTTP ${error.response.status})` : "";

    console.error("ServiceNow API Error:", JSON.stringify(error.response?.data) || error.message);

    return {
      content: [{
        type: "text",
        text: `❌ Error${statusCode}: ${errorMsg}${errorDetail ? ` — ${errorDetail}` : ""}`
      }],
      isError: true
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ ServiceNow MCP Agent v3.0 running...");