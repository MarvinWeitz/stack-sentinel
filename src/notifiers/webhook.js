import { describeFiles, groupFindings, recommendations } from '../report.js';
import { atLeast } from '../severity.js';

const ICON = { error: '🔴', warn: '🟠', info: '🔵', ok: '🟢' };

/** Adaptive Card payload, as accepted by Microsoft Teams "Workflows" incoming webhooks. */
export function teamsPayload(report, threshold, maxFindings) {
  const relevant = report.findings.filter((f) => atLeast(f.severity, threshold));
  const shown = groupFindings(relevant);
  const body = [
    { type: 'TextBlock', size: 'Medium', weight: 'Bolder', wrap: true,
      text: `${ICON[report.status]} stack-sentinel: ${report.project}` },
    { type: 'TextBlock', isSubtle: true, spacing: 'None', wrap: true,
      text: `${report.summary.error} error(s), ${report.summary.warn} warning(s), ${report.summary.info} info · ${report.generatedAt.slice(0, 10)} · v${report.toolVersion}` },
    ...(report.checks.skipped.length
      ? [{ type: 'TextBlock', isSubtle: true, spacing: 'None', wrap: true, text: `Skipped checks: ${report.checks.skipped.join(', ')}` }]
      : []),
    ...shown.slice(0, maxFindings).flatMap((f) => [
      { type: 'TextBlock', wrap: true, text: `${ICON[f.severity]} ${f.message}${f.files.length ? ` _(${describeFiles(f.files)})_` : ''}` },
      ...(f.action ? [{ type: 'TextBlock', wrap: true, spacing: 'None', text: `→ ${f.action}` }] : []),
    ]),
  ];
  if (shown.length > maxFindings) body.push({ type: 'TextBlock', isSubtle: true, text: `…and ${shown.length - maxFindings} more.` });
  // why the versions named in the actions: once per card, at the end
  for (const text of recommendations(relevant)) body.push({ type: 'TextBlock', isSubtle: true, wrap: true, text: `${text}.` });
  if (report.ignored?.length) {
    const n = groupFindings(report.ignored).length;
    body.push({ type: 'TextBlock', isSubtle: true, wrap: true, text: `${n} finding${n === 1 ? ' is' : 's are'} ignored by rules in the config file.` });
  }
  const prs = (report.pullRequests ?? []).filter((pr) => pr.url && pr.action !== 'closed');
  if (prs.length) {
    body.push({ type: 'TextBlock', weight: 'Bolder', wrap: true, text: 'Fix pull requests' });
    for (const pr of prs) body.push({ type: 'TextBlock', wrap: true, spacing: 'None', text: `[${pr.title}](${pr.url})${pr.action === 'created' ? ' (new)' : ''}` });
  }
  if (report.fixError) body.push({ type: 'TextBlock', wrap: true, text: `${ICON.error} Could not open fix pull requests: ${report.fixError}` });
  if (report.sharedConfig) body.push({ type: 'TextBlock', isSubtle: true, wrap: true, size: 'Small', text: `Shared config: ${report.sharedConfig}` });
  // buttons back to where the report came from
  const actions = [
    ...(report.links?.run ? [{ type: 'Action.OpenUrl', title: 'Open pipeline run', url: report.links.run }] : []),
    ...(report.links?.repository ? [{ type: 'Action.OpenUrl', title: 'Open repository', url: report.links.repository }] : []),
  ];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body,
        ...(actions.length ? { actions } : {}),
      },
    }],
  };
}

/** The start of a response body, to explain a refusal (for example Uptime Kuma's "Monitor not found or not active."). */
async function reason(res) {
  try {
    const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? `: ${text.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

/** Posts the report. format 'json' sends the raw report, for customer-owned endpoints. */
export async function notify(report, { url, format, threshold, maxFindings, timeoutSeconds, fetchImpl = fetch }) {
  const payload = format === 'json' ? report : teamsPayload(report, threshold, maxFindings);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!res.ok) throw new Error(`Webhook responded with HTTP ${res.status}${await reason(res)}`);
}

/**
 * The small "this project was scanned" message sent on every completed run. It carries
 * the outcome but no findings, so it is safe to send to a third-party monitoring service.
 */
export function heartbeatPayload(report) {
  return {
    tool: report.tool,
    toolVersion: report.toolVersion,
    project: report.project,
    generatedAt: report.generatedAt,
    status: report.status,
    summary: report.summary,
    checks: report.checks,
  };
}

/**
 * Sends the heartbeat. A service that expects regular pings can then alert when one is missing.
 * POST carries the status message; GET is for services that only accept GET (Uptime Kuma 1.x).
 */
export async function sendHeartbeat(report, { url, method = 'POST', timeoutSeconds, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(heartbeatPayload(report)) } : {}),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!res.ok) {
    const hint = method === 'POST' && (res.status === 404 || res.status === 405)
      ? ' If the address is right, the service may only accept GET requests (Uptime Kuma 1.x does): set SENTINEL_HEARTBEAT_METHOD=GET.'
      : '';
    throw new Error(`Heartbeat address responded with HTTP ${res.status}${await reason(res)}.${hint}`);
  }
}
