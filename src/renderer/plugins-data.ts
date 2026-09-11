/**
 * Catalog and model definitions for MCP Plugins and Tool Integrations.
 */

export interface McpTool {
  name: string;
  description: string;
  category?: string;
}

export interface McpPlugin {
  id: string;
  name: string;
  version: string;
  transport: 'stdio' | 'http' | 'sse' | 'loopback';
  category: 'core' | 'automation' | 'filesystem' | 'reasoning' | 'web' | 'custom';
  status: 'active' | 'standby' | 'disabled';
  description: string;
  author: string;
  endpointUrl?: string;
  toolsCount: number;
  tools: McpTool[];
  isBuiltIn: boolean;
  requiresWindows?: boolean;
}

export const BUILTIN_MCP_PLUGINS: McpPlugin[] = [
  {
    id: 'chat-on-steroids-core',
    name: 'Chat On Steroids Core',
    version: '2.1.0',
    transport: 'loopback',
    category: 'core',
    status: 'active',
    description: 'The primary capability bridge providing sandboxed file access, terminal execution, process supervision, session recordings, and multi-agent coordination.',
    author: 'Chat On Steroids Team',
    endpointUrl: 'http://127.0.0.1:8765/mcp/core',
    toolsCount: 8,
    isBuiltIn: true,
    tools: [
      { name: 'read', description: 'Read files and inspect directory metadata within approved roots.' },
      { name: 'view_image', description: 'View and inspect images with automatic model adaptation.' },
      { name: 'find', description: 'Search files and regex patterns within approved project folders.' },
      { name: 'apply_patch', description: 'Perform structured file edits, creates, renames, and deletions.' },
      { name: 'exec_command', description: 'Execute host shell commands and background process sessions.' },
      { name: 'write_stdin', description: 'Interact with running processes via standard input.' },
      { name: 'session', description: 'Read session recordings and manage durable execution state.' },
      { name: 'agents', description: 'Coordinate autonomous worker agents across tasks.' }
    ]
  },
  {
    id: 'chat-on-steroids-desktop',
    name: 'Desktop Automation MCP',
    version: '2.1.0',
    transport: 'loopback',
    category: 'automation',
    status: 'active',
    description: 'Windows-only desktop automation bridge providing screen capture, UI element inspection, mouse/keyboard SendInput, and clipboard access.',
    author: 'Chat On Steroids Team',
    endpointUrl: 'http://127.0.0.1:8765/mcp/desktop',
    toolsCount: 2,
    isBuiltIn: true,
    requiresWindows: true,
    tools: [
      { name: 'observe', description: 'Capture high-resolution screenshots and active window frames.' },
      { name: 'computer', description: 'Send mouse clicks, drags, key strokes, and clipboard actions (13 variants).' }
    ]
  },
  {
    id: 'chat-on-steroids-filesystem',
    name: 'Approved Filesystem MCP',
    version: '1.4.2',
    transport: 'stdio',
    category: 'filesystem',
    status: 'active',
    description: 'Fine-grained directory inspection and file manipulation strictly confined to user-approved workspace folders.',
    author: 'Inmersion Ecosystem',
    toolsCount: 6,
    isBuiltIn: true,
    tools: [
      { name: 'read_file', description: 'Read complete contents of any file in workspace.' },
      { name: 'write_file', description: 'Write or overwrite files with automated parent directory creation.' },
      { name: 'edit_file', description: 'Perform surgical string or regex replacements in files.' },
      { name: 'list_directory', description: 'List files and directories with size and item counts.' },
      { name: 'directory_tree', description: 'Generate recursive ASCII or structured directory trees.' },
      { name: 'search_files', description: 'Fast glob matching and pattern search across workspace.' }
    ]
  },
  {
    id: 'chat-on-steroids-git',
    name: 'Git Version Control MCP',
    version: '1.2.0',
    transport: 'stdio',
    category: 'filesystem',
    status: 'active',
    description: 'Safe, read-and-stage Git operations protecting against uncommitted data loss and unauthorized branch resets.',
    author: 'Inmersion Ecosystem',
    toolsCount: 7,
    isBuiltIn: true,
    tools: [
      { name: 'git_status', description: 'Inspect working tree status and modified files.' },
      { name: 'git_diff', description: 'Generate staged and unstaged diffs for reviewed paths.' },
      { name: 'git_log', description: 'View formatted commit history with SHA hashes.' },
      { name: 'git_show', description: 'Examine specific commits, patches, or revisions.' },
      { name: 'git_branch', description: 'List local and remote branches without switching.' },
      { name: 'git_diff_staged', description: 'Inspect staged changes ready for commit.' },
      { name: 'git_diff_unstaged', description: 'Inspect working tree edits not yet staged.' }
    ]
  },
  {
    id: 'chat-on-steroids-memory',
    name: 'Entity Graph Memory MCP',
    version: '1.1.0',
    transport: 'stdio',
    category: 'reasoning',
    status: 'active',
    description: 'Persistent knowledge graph storing entities, semantic relations, and cross-session observations.',
    author: 'Inmersion Ecosystem',
    toolsCount: 6,
    isBuiltIn: true,
    tools: [
      { name: 'create_entities', description: 'Add durable conceptual entities with name and category.' },
      { name: 'create_relations', description: 'Form directed relations between known entities.' },
      { name: 'add_observations', description: 'Attach timestamped facts and observations to entities.' },
      { name: 'read_graph', description: 'Retrieve the complete associative memory graph.' },
      { name: 'search_nodes', description: 'Query memory nodes matching text or tags.' },
      { name: 'open_nodes', description: 'Fetch full attributes and history for specific node keys.' }
    ]
  },
  {
    id: 'chat-on-steroids-sequential',
    name: 'Sequential Thinking MCP',
    version: '1.0.4',
    transport: 'stdio',
    category: 'reasoning',
    status: 'active',
    description: 'Multi-step reflective thinking mechanism allowing agents to hypothesize, verify, and revise thought trajectories.',
    author: 'Inmersion Ecosystem',
    toolsCount: 1,
    isBuiltIn: true,
    tools: [
      { name: 'sequentialthinking', description: 'Execute a structured, branchable chain-of-thought step.' }
    ]
  },
  {
    id: 'chat-on-steroids-fetch',
    name: 'Web Content Fetch MCP',
    version: '1.3.1',
    transport: 'http',
    category: 'web',
    status: 'active',
    description: 'Fast, secure HTTP fetch converting remote HTML web pages and API docs directly into clean Markdown.',
    author: 'Inmersion Ecosystem',
    toolsCount: 2,
    isBuiltIn: true,
    tools: [
      { name: 'fetch', description: 'Fetch static web documentation converted to Markdown.' },
      { name: 'web_search', description: 'Query external sources and summarize web results.' }
    ]
  }
];

export interface CustomMcpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  commandOrUrl: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
  enabled: boolean;
}
