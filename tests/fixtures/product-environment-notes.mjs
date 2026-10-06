// The PRODUCT environment notes (src/ui/product-prompt.js
// locusEnvironmentNotes at 2aec76e), verbatim content, as a TEST FIXTURE.
// The module itself stays Product-owned; the migrated agent suites need
// the exact notes text so their prompt-content assertions stay unchanged.
// Provenance: boccchi2993/Locus-browser-agent-runtime @ 2aec76e.
export function locusEnvironmentNotes(opts) {
  const workspace = opts && opts.workspace;
  const wsName = workspace ? (workspace.workspaceName || workspace.name) : null;
  return [
    '- Prefer the local bash tool for everything. If a task can be done with python or the commands above, do it locally.',
    '- Do not assume commands exist beyond the list above. If a command is not available, accomplish the same thing with python.',
    '- Do not ask the user to upload local files to an external service. If local input files are needed, the user can provide them through Locus at /mnt/upload. Uploaded files stay local unless the task explicitly requires a network transfer.',
    '- Do not transmit workspace contents or derived sensitive data to external network destinations unless the user',
    '  explicitly requests or clearly requires that transfer. Network access runs through the curl command, where',
    '  transport, approval and bounds are enforced. Python has no network access and no package downloads;',
    '  use curl for any HTTP/HTTPS need — fetch attempts from Python fail by design.',
    wsName
      ? 'An external folder "' + wsName + '" is currently mounted at /mnt/workspace (the default cwd).'
      : 'No external folder is currently mounted, so /mnt/workspace is unavailable; the default cwd is /home/locus. Use /mnt/upload for user-provided inputs (read-only), /mnt/download for files the user should receive, and /tmp for scratch space.',
  ].join('\n');
}
