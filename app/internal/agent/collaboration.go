package agent

// CollaborationTools are the tools of the app's MCP server. Adapters
// pre-approve exactly these; internal/mcp registers exactly these.
var CollaborationTools = []string{
	"send_message", "read_messages", "get_objective", "claim_task", "update_task", "submit_review",
}
