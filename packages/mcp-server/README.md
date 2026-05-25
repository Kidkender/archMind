# @archmind/mcp-server

**Exposes ArchMind's execution graph intelligence as MCP tools — usable directly from Claude Code without any extra setup.**

---

## What it enables

With the MCP server running, you can ask Claude Code questions like:

> *"Does `PUT /tasks/{id}` check that the user has permission to update this task?"*  
> *"Are there any N+1 query problems in this request trace?"*  
> *"Show me the authorization path for the task update endpoint."*

And get back structured, evidence-backed answers — not guesses based on reading random source files.

The server parses the Laravel project on first call, caches the result, and answers subsequent queries from the in-memory graph. No database, no server process, no configuration beyond pointing it at your project.

---

## Setup

Build the package:

```bash
cd packages/mcp-server && npm run build
```

Register in Claude Code's MCP settings:

```json
{
  "mcpServers": {
    "archmind": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

That's it. The first tool call triggers a full project parse. Subsequent calls are instant.

---

## Available tools

### `archmind_list_entrypoints`
Discover all HTTP routes in a Laravel project — method, path, and how complex each one is (node and edge count).

Useful as a first step to understand what's worth investigating.

### `archmind_get_execution_graph`
Return the full or focused semantic execution graph for a specific route.

Use the `focus` parameter to narrow to just the authorization path (`auth`), validation path (`validation`), transaction semantics (`transaction`), or tenant isolation patterns (`isolation`). Focused results use significantly fewer tokens.

### `archmind_get_findings`
Run all static and runtime detectors on an endpoint and return structured findings.

**Static findings** — authorization gaps, duplicate checks, event-before-commit, missing tenant scope, and more. No LLM call — these are deterministic.

**Runtime findings** (when you provide `trace_session_path`) — N+1 query patterns and slow database queries detected from an actual recorded request trace. These find issues static analysis cannot.

```
// Static only
archmind_get_findings(project_root, entrypoint, query?)

// Static + runtime
archmind_get_findings(project_root, entrypoint, query?, trace_session_path)
```

### `archmind_invalidate_cache`
Force a fresh parse. Call this after changing PHP source files.

---

## Why MCP matters here

Most code analysis tools require you to run a separate CLI, configure a language server, or pipe output through custom scripts. The MCP integration means ArchMind's analysis is available wherever Claude Code is — no context switching, no extra terminals, no output parsing.

Ask your AI assistant a question about your code. Get a structured answer with evidence. In the same conversation.

---

## What's coming

As ArchMind gains more capabilities — event listener tracing, queue job analysis, distributed request reconstruction — they'll all be exposed through the same four tools. The interface stays stable while the intelligence behind it grows.
