// The PRODUCT tool registry (src/tools.js AGENT_TOOL_DEFINITIONS at
// 2aec76e), verbatim content, as a TEST FIXTURE. In the source repository
// the eval-based suites loaded the Product file itself; the Harness
// package carries NO product tool registry (the ToolPort is injected),
// so the migrated suites inline the identical definitions here.
// Provenance: boccchi2993/Locus-browser-agent-runtime @ 2aec76e,
// src/tools.js. Product-owned content — never imported by src/.
export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'bash',
    description: 'Execute a command in the local browser Linux-like compatibility runtime. ' +
      'Use it for filesystem work, Python execution, text/data processing, and supported network operations.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  {
    name: 'cloud_bash',
    // Legacy/debug compatibility path (docs/NETWORK-RUNTIME.md): NOT a
    // network path — ordinary network work uses the local bash tool and
    // NetworkRuntime never needs it.
    description: 'Legacy remote execution fallback (debug/compatibility tool, not a network path). ' +
      'It is currently NOT configured, so calls fail. Ordinary shell and network work uses the local bash tool.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The shell command to execute remotely.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
];

export const AGENT_TOOL_NAMES = AGENT_TOOL_DEFINITIONS.map((t) => t.name);
