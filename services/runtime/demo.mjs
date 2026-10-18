import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function investigateDemo(input, emit, signal) {
  const { stdout } = await promisify(execFile)('python3', [
    fileURLToPath(new URL('./tools/demo-observability.py', import.meta.url)), '--incident', input.incident.description,
  ], { signal, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const pace = Number(process.env.DEMO_STEP_DELAY_MS || 450);
  for (const [index, evidence] of data.evidence.entries()) {
    const id = `${input.runId}-tool-${index}`;
    const tool = { id, label: evidence.source, detail: evidence.resource, status: 'running', started_at: new Date().toISOString() };
    emit('tool.updated', tool);
    await delay(pace, undefined, { signal });
    emit('tool.updated', { ...tool, detail: evidence.finding, status: 'completed', duration_ms: pace, evidence });
  }
  emit('evidence.collected', { evidence: data.evidence, timeline: data.timeline, correlation: data.correlation });
  const followup = input.messages.filter((m) => m.role === 'user').length > 1;
  const text = `## ${followup ? 'Revisiting the incident' : 'Investigation summary'}\n\n${followup ? 'This deterministic demo replays the same report-generation evidence for follow-up questions. Use OpenCode mode for conversational analysis.\n\n' : ''}Report generation is timing out for **${input.incident.customer}** in **${input.incident.environment}**. The evidence points to database latency compounded by worker memory pressure.\n\n### Likely root cause\n\n${data.correlation.most_likely_root_cause}\n\n### Evidence collected\n\n| Source | Finding |\n| --- | --- |\n${data.evidence.map((e) => `| ${e.source} | ${e.finding} |`).join('\n')}\n\n### Recommended next steps\n\n${data.recommended_actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n### Confidence · ${data.correlation.confidence}\n\n${data.correlation.less_likely_causes[0]} Correlate slow-query and memory metrics before confirming the cause.\n\n**Simulated evidence** · Fixed demo window: Aug 12, 2026, 09:55–10:10 UTC. No live Azure queries or remediation were performed.\n`;
  for (const delta of text.match(/.{1,36}(?:\s|$)|.{1,36}/gs) || []) {
    signal.throwIfAborted();
    emit('message.delta', { delta });
    await delay(Math.min(pace, 24), undefined, { signal });
  }
  emit('run.completed', { severity: data.correlation.severity });
}
