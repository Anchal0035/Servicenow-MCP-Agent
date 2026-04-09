import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const server = new Server(
  { name: "ticket-agent", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const SPRING_BOOT_URL = "http://localhost:8080/agent/create-ticket";

// ─────────────────────────────────────────
// LIST TOOLS
// ─────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [

      // ── RITM Tool ──────────────────────────────────────────
      {
        name: "create_ritm",
        description: `Create a ServiceNow RITM (service request) ticket.
          Use this when the user asks for access, software, hardware, VPN,
          or any general service request.
          Copilot must collect ALL required fields before calling this tool.
          Required fields: openedBy, requestedFor, item, shortDescription,
          description, priority, assignmentGroup, contactType.
          If any field is missing, ask the user for it before calling.
          Once all fields collected, show a summary table and wait for user to say YES.`,
        inputSchema: {
          type: "object",
          properties: {
            openedBy:          { type: "string", description: "Full name or email of person raising the ticket" },
            requestedFor:      { type: "string", description: "Email of the person who needs this service" },
            item:              { type: "string", description: "Catalog item name e.g. Pivotal Cloud Foundry (PCF)" },
            shortDescription:  { type: "string", description: "One line summary of the request" },
            description:       { type: "string", description: "Full detailed description of the request" },
            priority:          { type: "string", enum: ["1", "2", "3", "4"], description: "1=Critical, 2=High, 3=Medium, 4=Low" },
            assignmentGroup:   { type: "string", description: "Team responsible e.g. IT SN PCF Application" },
            contactType:       { type: "string", enum: ["Customer Portal", "Phone", "Email", "Self-service"], description: "How the request was raised" }
          },
          required: ["openedBy", "requestedFor", "item", "shortDescription", "description", "priority", "assignmentGroup", "contactType"]
        }
      },

      // ── Change Tool ────────────────────────────────────────
      {
        name: "create_change_request",
        description: `Create a ServiceNow Change Request ticket.
          Use this when user mentions deployment, release, infrastructure change, or maintenance.
          Copilot must collect ALL required fields before calling this tool.
          Required fields: openedBy, shortDescription, description, priority,
          assignmentGroup, changeType, riskLevel, plannedStart, plannedEnd.
          If any field is missing, ask the user for it before calling.
          Once all fields collected, show a summary table and wait for user to say YES.`,
        inputSchema: {
          type: "object",
          properties: {
            openedBy:         { type: "string", description: "Full name or email of person raising the ticket" },
            shortDescription: { type: "string", description: "One line summary of the change" },
            description:      { type: "string", description: "Full detailed description of the change" },
            priority:         { type: "string", enum: ["1", "2", "3", "4"], description: "1=Critical, 2=High, 3=Medium, 4=Low" },
            assignmentGroup:  { type: "string", description: "Team responsible" },
            changeType:       { type: "string", enum: ["normal", "standard", "emergency"], description: "Type of change" },
            riskLevel:        { type: "string", enum: ["low", "medium", "high"], description: "Risk level of the change" },
            plannedStart:     { type: "string", description: "Planned start date YYYY-MM-DD HH:MM" },
            plannedEnd:       { type: "string", description: "Planned end date YYYY-MM-DD HH:MM" }
          },
          required: ["openedBy", "shortDescription", "description", "priority", "assignmentGroup", "changeType", "riskLevel", "plannedStart", "plannedEnd"]
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

  // ── Create RITM ───────────────────────────────────────────
  if (name === "create_ritm") {
    try {
      const response = await axios.post(SPRING_BOOT_URL, {
        ticketType: "RITM",
        openedBy:         args.openedBy,
        requestedFor:     args.requestedFor,
        item:             args.item,
        shortDescription: args.shortDescription,
        description:      args.description,
        priority:         args.priority,
        assignmentGroup:  args.assignmentGroup,
        contactType:      args.contactType
      });

      const number = extractTicketNumber(response.data);
      return {
        content: [{
          type: "text",
          text: `✅ RITM created successfully!\n\n**Ticket Number: ${number}**`
        }]
      };
    } catch (error) {
      console.error("RITM creation error:", error.message);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to create RITM: ${error.message}`
        }]
      };
    }
  }

  // ── Create Change Request ──────────────────────────────────
  if (name === "create_change_request") {
    try {
      const response = await axios.post(SPRING_BOOT_URL, {
        ticketType:       "CHANGE",
        openedBy:         args.openedBy,
        shortDescription: args.shortDescription,
        description:      args.description,
        priority:         args.priority,
        assignmentGroup:  args.assignmentGroup,
        changeType:       args.changeType,
        riskLevel:        args.riskLevel,
        plannedStart:     args.plannedStart,
        plannedEnd:       args.plannedEnd
      });

      const number = extractTicketNumber(response.data);
      return {
        content: [{
          type: "text",
          text: `✅ Change Request created successfully!\n\n**Ticket Number: ${number}**`
        }]
      };
    } catch (error) {
      console.error("Change creation error:", error.message);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to create Change Request: ${error.message}`
        }]
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─────────────────────────────────────────
// HELPER — extract ticket number from response
// ─────────────────────────────────────────
function extractTicketNumber(data) {
  return (
    data?.ticketResponse?.result?.number?.value ??
    data?.ticketResponse?.result?.number ??
    data?.result?.number?.value ??
    data?.result?.number ??
    data?.number ??
    "UNKNOWN"
  );
}

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.log("✅ Ticket MCP Agent running...");