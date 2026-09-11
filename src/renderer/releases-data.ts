/**
 * Authoritative release notes data for Chat On Steroids.
 *
 * Captures the complete engineering and product journey from the initial v1.9.2
 * public release through the active v2.2.0 multi-device and Core isolation line.
 */

export interface ReleaseChangeItem {
  text: string;
  badge?: string;
  details?: string;
}

export interface ReleaseCategory {
  id: 'feat' | 'core' | 'fix' | 'sec' | 'ui';
  title: string;
  items: ReleaseChangeItem[];
}

export interface ReleaseEntry {
  version: string;
  title: string;
  date: string;
  channel: 'dev' | 'stable' | 'patch' | 'upstream';
  tag: string;
  summary: string;
  categories: ReleaseCategory[];
  highlights?: string[];
  artifacts?: string[];
}

export const RELEASES_DATA: ReleaseEntry[] = [
  {
    version: '2.2.0',
    title: 'Multi-Device Fleet, Core Supervisor & Design Polish',
    date: 'Active Development (2026)',
    channel: 'dev',
    tag: 'Active Development',
    summary:
      'Major leap introducing the headless Multi-Device Node Agent for local network computer control, detached Core Supervisor daemon with auto crash backoff, write-only secret isolation, agent health engine, and a complete titlebar/header/sidebar visual upgrade.',
    highlights: [
      'Multi-Device Node Agent: Pair and command remote computers over LAN/Tailscale with ephemeral 10-minute tokens',
      'Persistent Core Host & Supervisor: Detached background daemon keeps execution alive across UI restarts with health watchdog',
      'Agent Health Engine: Real-time liveness evidence and read-only pure health projections in Control Center',
      'Aesthetic UI Polish: Compact 32px titlebar captions, breadcrumb navigation, bridge endpoint chip, and enhanced dark/light harmony'
    ],
    categories: [
      {
        id: 'feat',
        title: 'Multi-Device & Fleet Control',
        items: [
          {
            text: 'Headless Node Agent service for remote Windows computers, executable independently from the main Electron shell via scripts/run-node-agent.mjs.',
            badge: 'Node Agent'
          },
          {
            text: 'Ephemeral pairing ticket protocol with 10-minute expiration window, single-use verification, and cryptographically random session tokens.',
            badge: 'Pairing'
          },
          {
            text: 'Device Registry with live ping health tracking, permitted tool surface negotiation, and coordinator/node role routing.',
            badge: 'Registry'
          },
          {
            text: 'Dedicated Devices panel in UI displaying managed computers, connection status, approved tools, and active remote workspaces.',
            badge: 'UI'
          }
        ]
      },
      {
        id: 'core',
        title: 'Core Architecture & Supervisor',
        items: [
          {
            text: 'Detached Core Supervisor daemon with exclusive single-instance lock, monitoring Core Host health and restarting crashed instances.',
            badge: 'Supervisor'
          },
          {
            text: 'Exponential crash backoff loop preventing rapid spawn storms when persistent errors occur.',
            badge: 'Stability'
          },
          {
            text: 'Persistent Core Authority decouples Electron UI into a presentation-only client; config mutations and secrets live in the Core Host process.',
            badge: 'Architecture'
          },
          {
            text: 'Generation-bound IPC channels preventing stale responses across Core restarts or helper replacements.',
            badge: 'IPC'
          }
        ]
      },
      {
        id: 'sec',
        title: 'Security & Secret Isolation',
        items: [
          {
            text: 'Write-only secret commands over Core protocol v4: secrets are stored in Electron safeStorage and never broadcast back to the renderer.',
            badge: 'Vault'
          },
          {
            text: 'Durable session redaction markers and scrubbed nested credential fields in recorded session outputs.',
            badge: 'Redaction'
          },
          {
            text: 'Controlled installer update handoff: UI Core and supervisor PIDs exit gracefully before NSIS elevation to prevent file locks.',
            badge: 'Updater'
          }
        ]
      },
      {
        id: 'ui',
        title: 'UI Design & Visual Harmony',
        items: [
          {
            text: 'Titlebar overlay caption buttons reduced to 32px height for a sleek, native Windows 11 window integration.',
            badge: 'Titlebar'
          },
          {
            text: 'Interactive breadcrumb navigation with Section / View indicators and live bridge endpoint chip in the top header.',
            badge: 'Header'
          },
          {
            text: 'Redesigned sidebar rail with status pulse dot, quick connection toggle, and compact system check trigger.',
            badge: 'Sidebar'
          },
          {
            text: 'Upgraded color harmony across both light and dark themes using modern slate tones and vibrant royal/azure accents.',
            badge: 'Palette'
          }
        ]
      },
      {
        id: 'fix',
        title: 'Reliability & Bug Fixes',
        items: [
          {
            text: 'Background worker tabs protected from browser auto-discard during long-running tasks.',
            badge: 'Tabs'
          },
          {
            text: 'Reconciled workspace roots inside Core authority to prevent out-of-sync directory lists.',
            badge: 'Roots'
          }
        ]
      }
    ],
    artifacts: [
      'Chat-On-Steroids-Setup-x64.exe (Windows x64)',
      'Chat-On-Steroids-Setup-arm64.exe (Windows ARM64)',
      'node-agent-win-x64.zip (Standalone Remote Node Agent)',
      'Chat-On-Steroids-Extension.zip (Companion Extension)'
    ]
  },
  {
    version: '2.1.2',
    title: 'Upstream Synchronization & Reliability Patch',
    date: 'August 2026',
    channel: 'stable',
    tag: 'Latest Stable',
    summary:
      'Reliability and synchronization patch for the 2.1 autonomous line. Ensures worker tabs remain alive for attribution, binds desktop replies to helper generations, and introduces expandable tool disclosures.',
    highlights: [
      'Worker command tabs remain open after bootstrap ACK until durable terminal evidence is recorded',
      'Desktop automation replies bound strictly to helper-process generations',
      'Native <details> disclosures for app-owned tool activity rows with bounded metadata'
    ],
    categories: [
      {
        id: 'core',
        title: 'Attribution & Worker Lifecycle',
        items: [
          {
            text: 'Worker command tabs remain open after bootstrap acknowledgement and are released only by the dedicated agent-tab lifecycle after durable sleeping/terminal evidence.',
            badge: 'Attribution'
          },
          {
            text: 'Desktop automation binds replies to the exact helper-process generation that issued the request; stale frame or ref replies are rejected.',
            badge: 'Desktop'
          },
          {
            text: 'Bridge shutdown test suite deterministically waits for in-flight request acceptance before evaluating drain behavior.',
            badge: 'Testing'
          }
        ]
      },
      {
        id: 'ui',
        title: 'Activity Disclosures & Access',
        items: [
          {
            text: 'App-owned tool activity rows can be expanded with native <details> disclosures, showing tool name, outcome, duration, and capped path counts.',
            badge: 'Activity'
          },
          {
            text: 'Tool disclosures explicitly exclude raw tool arguments, results, and sensitive credentials.',
            badge: 'Privacy'
          },
          {
            text: 'Folder access remains reachable post-setup in Settings without widening approved roots.',
            badge: 'Folders'
          }
        ]
      },
      {
        id: 'fix',
        title: 'Provenance & Packaging',
        items: [
          {
            text: 'Restored upstream release notes (2.0.3, 2.0.4, 2.0.5) for historical lineage and provenance.',
            badge: 'Lineage'
          },
          {
            text: 'Pre-warmed app-builder-lib in AppImage packaging tests to eliminate 30-second CI timeout flakes.',
            badge: 'CI'
          }
        ]
      }
    ],
    artifacts: [
      'Chat-On-Steroids-Setup-x64.exe (Windows x64)',
      'Chat-On-Steroids-Setup-arm64.exe (Windows ARM64)',
      'Chat-On-Steroids-macOS-x64.dmg / zip (macOS Intel)',
      'Chat-On-Steroids-macOS-arm64.dmg / zip (macOS Apple Silicon)',
      'Chat-On-Steroids-Linux-x64.AppImage / deb (Linux x64)',
      'Chat-On-Steroids-Linux-arm64.AppImage / deb (Linux ARM64)',
      'Chat-On-Steroids-Extension.zip'
    ]
  },
  {
    version: '2.1.1',
    title: 'Background Staged Updates & Line-Range Reads',
    date: 'August 2026',
    channel: 'patch',
    tag: 'Distribution Patch',
    summary:
      'Seamless update staging in the background, range-targeted file reads (path:start-end), checksum-bound session cursors, and macOS 13 Ventura baseline.',
    highlights: [
      'Background update staging with SHA-256 validation; updates survive restarts and install on command',
      'Multi-range file reads in a single read call with nearest-folder suggestions on missing paths',
      'Compact checksum-bound session tokens replacing heavy base64 payloads'
    ],
    categories: [
      {
        id: 'feat',
        title: 'Updater & Distribution',
        items: [
          {
            text: 'Windows and Linux AppImage packages stage newer releases in the background, verified against published SHA-256 checksums.',
            badge: 'Updater'
          },
          {
            text: 'Staged artifacts survive application restart without re-downloading.',
            badge: 'Cache'
          },
          {
            text: 'Upgraded bundled OpenAI tunnel-client to v0.0.14 with verified platform checksums.',
            badge: 'Tunnel'
          },
          {
            text: 'macOS baseline updated to macOS 13 Ventura, matching the native tunnel payload requirement.',
            badge: 'macOS'
          }
        ]
      },
      {
        id: 'core',
        title: 'File Tools & Session Reliability',
        items: [
          {
            text: 'read tool accepts line ranges attached to paths (e.g. path:12-40), allowing multiple extracts from one file in a single turn.',
            badge: 'Read'
          },
          {
            text: 'Missing read paths automatically suggest the nearest existing folder listing when browsing is permitted.',
            badge: 'Discovery'
          },
          {
            text: 'Session cursors are compact checksum-bound tokens instead of bulky base64 JSON structures.',
            badge: 'Session'
          }
        ]
      },
      {
        id: 'sec',
        title: 'Sandbox Permissions',
        items: [
          {
            text: 'Windows installer repairs the Electron sandbox read/execute ACL on installed trees without disabling Chromium security.',
            badge: 'ACL'
          }
        ]
      }
    ]
  },
  {
    version: '2.1.0',
    title: 'Agent System 3.0, Control Center & Autonomous Execution',
    date: 'August 2026',
    channel: 'stable',
    tag: 'Major Architecture',
    summary:
      'A monumental milestone introducing Agent System 3.0 DAG task orchestration, the visual Control Center canvas, durable autonomous desktop execution, Infinite Loop, and background browser orchestration.',
    highlights: [
      'Agent System 3.0: Directed acyclic graph (DAG) task scheduling, multi-agent worker allocation, and recovery hooks',
      'Control Center: Live visual canvas displaying agent hierarchies, task dependencies, and telemetry',
      'Durable Execution: Start, pause, resume, and inspect long-running tasks via session tool',
      'Infinite Loop: Autonomous execution loop with decision delegation and automatic turn rollover'
    ],
    categories: [
      {
        id: 'feat',
        title: 'Agent System 3.0 & Control Center',
        items: [
          {
            text: 'Integrated Agent System 3.0 featuring DAG-based task decomposition, worker concurrency allocation, and automated retry policies.',
            badge: 'DAG'
          },
          {
            text: 'Interactive Control Center dashboard with visual node graphs, live blocker inspection, and search filtering.',
            badge: 'Canvas'
          },
          {
            text: 'Infinite Loop mode with autonomous continuation and intelligent decision delegation.',
            badge: 'Loop'
          }
        ]
      },
      {
        id: 'core',
        title: 'Durable Autonomous Execution',
        items: [
          {
            text: 'Expanded session tool with execution_start, execution_status, execution_pause, execution_resume, and execution_stop.',
            badge: 'Session'
          },
          {
            text: 'Dedicated isolated windows for agent browser operations bound strictly to originating ChatGPT conversations.',
            badge: 'Isolation'
          },
          {
            text: 'Persistent terminal process sessions continue safely across chat boundaries with uninterrupted attribution.',
            badge: 'Terminal'
          }
        ]
      },
      {
        id: 'fix',
        title: 'Browser & Window Auto-Healing',
        items: [
          {
            text: 'Worker tabs spawn in the background without stealing user focus from active chats.',
            badge: 'Browser'
          },
          {
            text: 'Disabled Chrome renderer backgrounding and timer throttling to prevent background ChatGPT stalls.',
            badge: 'Throttling'
          },
          {
            text: 'Desktop shortcut auto-heals on app startup and packaging; window elevation pops app over full-screen browsers.',
            badge: 'Windows'
          }
        ]
      }
    ]
  },
  {
    version: '2.0.5',
    title: 'Update Installer Integration & Layout Fixes',
    date: 'August 2026',
    channel: 'patch',
    tag: 'Stability Release',
    summary:
      'Direct in-app "Install update" action, single-fetch staged caching across restarts, and notice banner styling adjustments.',
    categories: [
      {
        id: 'feat',
        title: 'Update Management',
        items: [
          {
            text: 'Install update button directly in header and update banner when a verified download is ready.',
            badge: 'Updater'
          },
          {
            text: 'Staged downloads cached persistently under release identity to prevent redundant network fetches on every start.',
            badge: 'Cache'
          }
        ]
      },
      {
        id: 'ui',
        title: 'Layout & Banner Geometry',
        items: [
          {
            text: 'Fixed update banner layout clipping between the top header and content panels.',
            badge: 'Layout'
          }
        ]
      }
    ]
  },
  {
    version: '2.0.4',
    title: 'Tool Request Resilience',
    date: 'August 2026',
    channel: 'patch',
    tag: 'Maintenance',
    summary: 'Hardened tool request handling and improved stream reliability.',
    categories: [
      {
        id: 'fix',
        title: 'Tool Pipeline',
        items: [
          {
            text: 'Addressed edge cases in tool request dispatch and body stream parsing.',
            badge: 'MCP'
          },
          {
            text: 'General stability improvements across IPC message handling.',
            badge: 'IPC'
          }
        ]
      }
    ]
  },
  {
    version: '2.0.3',
    title: 'The Loop & Autonomous Recovery',
    date: 'August 2026',
    channel: 'upstream',
    tag: 'Historical Upstream',
    summary:
      'Pioneered The Loop for autonomous consecutive turns, auto tab reloads on silent chats, and initial macOS Desktop connector support.',
    categories: [
      {
        id: 'feat',
        title: 'Autonomous Continuation',
        items: [
          {
            text: 'The Loop: Goal execution with the exit removed, triggering consecutive messages until manually stopped.',
            badge: 'Loop'
          },
          {
            text: 'Self-healing tab auto-reloads when chats stall, show errors, or lose their browser tab.',
            badge: 'Recovery'
          },
          {
            text: 'Desktop connector support previewed for macOS environments.',
            badge: 'macOS'
          }
        ]
      }
    ]
  },
  {
    version: '2.0.2',
    title: 'Cross-Platform Packaging Matrix',
    date: 'August 2026',
    channel: 'stable',
    tag: 'Platform Release',
    summary:
      'Native packaging for Windows, macOS (Intel & Apple Silicon), and Linux (AppImage & DEB). Architecture-specific binaries and POSIX host hardening.',
    categories: [
      {
        id: 'core',
        title: 'Cross-Platform Matrix',
        items: [
          {
            text: 'Six-job native build matrix: Windows x64/arm64, macOS Intel/Apple Silicon, Linux x64/arm64.',
            badge: 'Matrix'
          },
          {
            text: 'Bundled platform-specific native binaries for Sharp, node-pty, tree-sitter, ripgrep, and tunnel-client.',
            badge: 'Binaries'
          },
          {
            text: 'POSIX host audited: environment scrubbing, tray lifecycle, and process signals conform to Linux/macOS standards.',
            badge: 'POSIX'
          }
        ]
      }
    ]
  },
  {
    version: '2.0.1',
    title: 'Worker Revival & Crash Hardening',
    date: 'August 2026',
    channel: 'patch',
    tag: 'Hardening Patch',
    summary:
      'Reusable sleeping worker conversations across app restarts, batch shell command execution, and DPI-scaled resizable windows.',
    categories: [
      {
        id: 'core',
        title: 'Worker & Session Hardening',
        items: [
          {
            text: 'Workers sleep and revive within existing ChatGPT conversations instead of creating disposable one-off tabs.',
            badge: 'Workers'
          },
          {
            text: 'Session metadata reconciled against newer event/message history following abrupt application crashes.',
            badge: 'Recovery'
          },
          {
            text: 'exec_command supports related cmds batches in a single shell session with bounded output.',
            badge: 'Exec'
          }
        ]
      },
      {
        id: 'ui',
        title: 'Window Geometry & Scaling',
        items: [
          {
            text: 'Main window resizable and maximizable; fits smaller displays and high-DPI Windows scaling without clipping controls.',
            badge: 'Window'
          },
          {
            text: 'Paged session history with bounded delta refreshes.',
            badge: 'History'
          }
        ]
      }
    ]
  },
  {
    version: '2.0.0',
    title: 'The Goal Loop & Security Scrubbing',
    date: 'August 2026',
    channel: 'stable',
    tag: 'Major Architecture',
    summary:
      'Introduced The Goal Loop with second-model OpenRouter steering, apply_patch self-move deletion prevention, virtual root glob fixes, and connector environment credential scrubbing.',
    categories: [
      {
        id: 'feat',
        title: 'The Goal Loop',
        items: [
          {
            text: 'Second model reads finished ChatGPT turns and writes next instructions toward a verified goal via OpenRouter.',
            badge: 'Goal'
          },
          {
            text: 'Strict 4-signal turn completion barrier: stop button gone, stream settled, tool rail still, no open local call held for 8s.',
            badge: 'Barrier'
          },
          {
            text: 'Privacy guarantee: only user prompts and final assistant answers leave the machine; raw tool payloads stay local.',
            badge: 'Privacy'
          }
        ]
      },
      {
        id: 'sec',
        title: 'Security & Sandbox Fixes',
        items: [
          {
            text: 'Tunnel child processes scrub ambient environment variables to avoid leaking developer credentials or provider keys.',
            badge: 'Tunnel'
          },
          {
            text: 'apply_patch move verification: prevents source deletion when moving a file onto itself (e.g. source.txt -> ./source.txt).',
            badge: 'Patch'
          },
          {
            text: 'Fixed wildcard glob search (*.ts) resolving against virtual roots instead of project cwd.',
            badge: 'Sandbox'
          }
        ]
      }
    ]
  },
  {
    version: '1.9.8',
    title: 'Ripgrep Bundling & Ripgrep Normalizer Safety',
    date: 'August 2026',
    channel: 'patch',
    tag: 'Core Reliability',
    summary:
      'Shipped bundled ripgrep binaries, strict argument parsing, and compaction deadlock fixes.',
    categories: [
      {
        id: 'core',
        title: 'Search & Tools',
        items: [
          {
            text: 'Bundled standalone ripgrep binary into application packaging rather than relying on system PATH.',
            badge: 'Ripgrep'
          },
          {
            text: 'Stopped normalizer guessing PowerShell option arity; prevent laundering real failures as empty results.',
            badge: 'Parser'
          },
          {
            text: 'Prevented one conversation compaction from blocking concurrent sessions.',
            badge: 'Compaction'
          }
        ]
      }
    ]
  },
  {
    version: '1.9.5',
    title: 'Swarm Multi-Agent & Companion Extension',
    date: 'August 2026',
    channel: 'stable',
    tag: 'Multi-Agent Launch',
    summary:
      'Multi-agent swarm persistence across full process lifetime, companion extension download integration, and auto-pairing.',
    categories: [
      {
        id: 'feat',
        title: 'Multi-Agent Swarm',
        items: [
          {
            text: 'Swarm persistence wired for the whole process lifetime so enabling multi-agent after startup works immediately.',
            badge: 'Swarm'
          },
          {
            text: 'Companion Chrome extension direct pairing and status dashboard.',
            badge: 'Extension'
          }
        ]
      }
    ]
  },
  {
    version: '1.9.2',
    title: 'First Public Beta (ChatGPT Local Files)',
    date: 'July 2026',
    channel: 'stable',
    tag: 'Initial Beta',
    summary:
      'First public release of the local coding bridge for ChatGPT over MCP, introducing approved folders, local terminal execution, and the Chrome extension recorder.',
    categories: [
      {
        id: 'feat',
        title: 'Initial Foundation',
        items: [
          {
            text: 'Local MCP server bridge over secure OpenAI tunnel protocol.',
            badge: 'MCP'
          },
          {
            text: 'Approved-folder filesystem sandbox limiting ChatGPT file access.',
            badge: 'Sandbox'
          },
          {
            text: 'Terminal exec_command execution with approval and read-only toggles.',
            badge: 'Exec'
          }
        ]
      }
    ]
  }
];
