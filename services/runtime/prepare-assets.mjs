import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Preserve imported sources verbatim; only the generated OpenCode copies need
// discovery metadata and last-match-wins permission ordering.
export async function prepareAssets(workspace, env = process.env) {
  const source = await fs.readFile(path.join(workspace, 'agents/triage-agent.md'), 'utf8');
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
  if (!match) throw new Error('Triage agent frontmatter is missing');
  let metadata = match[2].replace(
    '  skill:\n    azure-observability-demo: allow\n    "*": deny',
    '  skill:\n    "*": deny\n    azure-observability-demo: allow',
  );
  if (env.TRIAGE_LIVE_AZURE_ENABLED !== 'true') {
    metadata = metadata.replace('\n  skill:', '\n    "az *": deny\n  skill:');
  }
  if (env.TRIAGE_LIVE_AZURE_ENABLED === 'true' && env.AZURE_RESOURCE_GROUP) {
    metadata = metadata.replace('  read: allow', '  read:\n    "*": deny\n    "/workspace/AGENTS.md": allow\n    "/workspace/skills/**": allow\n    "/workspace/.opencode/skills/**": allow');
    metadata = metadata.replace('    "date*": allow', '    "date*": deny');
    metadata = metadata.replace('    "python3 /workspace/tools/demo-observability.py*": allow', '    "python3 /workspace/tools/demo-observability.py*": deny');
    metadata = metadata.replace('\n  skill:', '\n    "az *": deny\n    "python3 /workspace/tools/azure-observability.py*": allow\n  skill:');
    metadata += '\n    azure-resource-group: allow';
  }
  const agentDir = path.join(workspace, '.opencode/agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'triage-agent.md'), `${match[1]}${metadata}${match[3]}${match[4]}`);

  const skill = await fs.readFile(path.join(workspace, 'skills/azure-observability-demo/SKILL.md'), 'utf8');
  const skillDir = path.join(workspace, '.opencode/skills/azure-observability-demo');
  await fs.mkdir(skillDir, { recursive: true });
  const header = '---\nname: azure-observability-demo\ndescription: Use for Azure incident triage with seeded observability evidence or explicitly requested read-only live diagnostics.\n---\n\n';
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skill.startsWith('---\n') ? skill : header + skill);
  const liveSkill = path.join(workspace, 'skills/azure-resource-group');
  try { await fs.cp(liveSkill, path.join(workspace, '.opencode/skills/azure-resource-group'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareAssets(process.argv[2] || '/workspace');
}
