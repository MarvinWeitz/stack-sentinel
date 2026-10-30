import { describeFiles, groupFindings } from './report.js';

/**
 * The dashboard: one issue (GitHub) or work item (Azure DevOps) per repository that always
 * shows the latest report, modeled on Renovate's Dependency Dashboard. People who never see
 * the Teams channel find it where they plan their work, and it says what is open, which fix
 * pull requests wait for review, and what is ignored and until when.
 */

const ICON = { error: '🔴', warn: '🟠', info: '🔵', ok: '🟢' };
const MAX_ROWS = 150;
export const DASHBOARD_MARKER = '<!-- stack-sentinel-dashboard -->';

/**
 * What the dashboard says, as blocks that render to Markdown (GitHub) or HTML (Azure DevOps):
 * { type: 'p', text } | { type: 'h', text } | { type: 'table', head, rows } | { type: 'list', items }.
 * Text may hold [label](url) links and `code`; nothing else is interpreted.
 */
export function dashboardBlocks(report) {
  const blocks = [];
  const date = report.generatedAt.slice(0, 10);
  const run = report.links?.run ? ` in [this run](${report.links.run})` : '';
  const counts = `${report.summary.error} error(s), ${report.summary.warn} warning(s), ${report.summary.info} info`;
  blocks.push({ type: 'p', text: `${ICON[report.status]} **${report.status.toUpperCase()}**: ${counts}. Scanned on ${date}${run}.` });
  if (report.fixError) blocks.push({ type: 'p', text: `${ICON.error} Fix pull requests could not be opened: ${report.fixError}` });

  const open = groupFindings(report.findings.filter((f) => f.severity !== 'ok'));
  blocks.push({ type: 'h', text: 'Findings' });
  if (open.length === 0) blocks.push({ type: 'p', text: 'Nothing to do.' });
  else {
    const rows = open.slice(0, MAX_ROWS).map((g) => [`${ICON[g.severity]} ${g.severity}`, g.message, g.files.length ? describeFiles(g.files) : '', g.action ?? '']);
    blocks.push({ type: 'table', head: ['Severity', 'Finding', 'Where', 'What to do'], rows });
    if (open.length > MAX_ROWS) blocks.push({ type: 'p', text: `…and ${open.length - MAX_ROWS} more; the JSON report has them all.` });
  }

  const prs = (report.pullRequests ?? []).filter((pr) => pr.url && pr.action !== 'closed');
  if (prs.length) {
    blocks.push({ type: 'h', text: 'Fix pull requests' });
    blocks.push({ type: 'list', items: prs.map((pr) => `[${pr.title}](${pr.url})${pr.autoMerge ? ' (merges by itself once its checks pass)' : ''}`) });
  }
  const waiting = (report.pullRequests ?? []).filter((pr) => pr.action === 'skipped');
  if (waiting.length) {
    blocks.push({ type: 'h', text: 'Not opened' });
    blocks.push({ type: 'list', items: waiting.map((pr) => `${pr.title}: ${pr.reason}`) });
  }

  if (report.ignored?.length) {
    blocks.push({ type: 'h', text: 'Ignored' });
    const rows = groupFindings(report.ignored).map((g) => {
      const by = report.ignored.find((f) => f.message === g.message).ignoredBy;
      return [g.message, g.files.length ? describeFiles(g.files) : '', by.reason ?? '', by.until ?? 'no end date'];
    });
    blocks.push({ type: 'table', head: ['Finding', 'Where', 'Why', 'Until'], rows });
  }

  const ok = report.findings.filter((f) => f.severity === 'ok').length;
  blocks.push({ type: 'p', text: `Checks run: ${report.checks.run.join(', ')}${report.checks.skipped.length ? `; skipped: ${report.checks.skipped.join(', ')}` : ''}.`
    + `${ok ? ` ${ok} place${ok === 1 ? ' is' : 's are'} up to date.` : ''}` });
  blocks.push({ type: 'p', text: `Kept up to date by [stack-sentinel](https://github.com/cbs-consulting/stack-sentinel) ${report.toolVersion} on every run. `
    + 'Change it in the project, not here: edits to this text are replaced. To stop it, turn dashboard.enabled off.' });
  return blocks;
}

const mdCell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function toMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'p') out.push(b.text, '');
    if (b.type === 'h') out.push(`### ${b.text}`, '');
    if (b.type === 'list') out.push(...b.items.map((i) => `- ${i}`), '');
    if (b.type === 'table') {
      out.push(`| ${b.head.join(' | ')} |`, `| ${b.head.map(() => '---').join(' | ')} |`, ...b.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`), '');
    }
  }
  return [...out, DASHBOARD_MARKER].join('\n');
}

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text to HTML: escaped first, then the [label](url), `code` and **bold** the blocks use. */
const inline = (text) => escape(text)
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

export function toHtml(blocks) {
  return blocks.map((b) => {
    if (b.type === 'p') return `<p>${inline(b.text)}</p>`;
    if (b.type === 'h') return `<h3>${inline(b.text)}</h3>`;
    if (b.type === 'list') return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
    return `<table><tr>${b.head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  }).join('\n');
}

/** The dashboard's title: `title` with {project} replaced. */
export const dashboardTitle = (report, title) => title.replace('{project}', report.project);

/**
 * Creates the dashboard, or updates the one an earlier run made. `provider` is the platform's
 * (src/fix/github.js or azure.js). Returns { action: 'created' | 'updated' | 'unchanged', url }.
 */
export async function updateDashboard(report, provider, { title, label }) {
  const blocks = dashboardBlocks(report);
  const name = dashboardTitle(report, title);
  const body = provider.platform === 'azure-devops' ? toHtml(blocks) : toMarkdown(blocks);
  const existing = await provider.findDashboard({ title: name, label });
  if (!existing) return { action: 'created', url: (await provider.createDashboard({ title: name, body, label })).url };
  if (existing.title === name && existing.body === body) return { action: 'unchanged', url: existing.url };
  await provider.updateDashboard(existing, { title: name, body });
  return { action: 'updated', url: existing.url };
}
