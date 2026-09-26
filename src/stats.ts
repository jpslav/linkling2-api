// The stats page (ADR-0015): every link with its last 14 days, busiest first, rendered here
// on the server. The page loads only its own stylesheet and script, both under `/-/`, so
// the team-key guard in app.ts covers all three routes and nothing comes from elsewhere.
import type { FastifyInstance, FastifyReply } from "fastify";
import { utcDay } from "./db/links.js";
import { isExpired } from "./links.js";
import { expiryOf, type LinkStore, type StoredLink } from "./store.js";

export interface StatsDeps {
  links: LinkStore;
  now: () => Date;
  /** The public site's address (LINKLING_SITE); undefined while it has none. */
  site?: string | undefined;
}

/** How many UTC days the line and the sort look back over, today included. */
export const DAYS = 14;

/**
 * Where the footer's Privacy link goes while the public site has no address: the page's
 * published source in the public repo (run decision 2026-09-26, DECISIONS.md).
 */
export const PRIVACY_FALLBACK = "https://github.com/jpslav/linkling2-web/blob/main/privacy.html";

/** R-029: what a count includes, said on this page as on the privacy page. */
export const PREVIEW_SENTENCE =
  "Counts include the automatic fetch chat apps make to preview a pasted link.";

/** Why LINKLING_SITE cannot be used, or null when it can (or is not set). */
export function siteProblem(site: string | undefined): string | null {
  if (site === undefined || site === "") return null;
  const problem = "must be the public site's http or https address, such as https://linkling.example.org";
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    return problem;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return problem;
  // `?` and `#` are tested on the text, since URL reports an empty query or fragment as "".
  // Spaces and control characters are refused too: URL would quietly drop them at the ends.
  if (url.username !== "" || url.password !== "" || /[?#\x00-\x20\x7f]/.test(site)) return problem;
  return null;
}

/**
 * The public site's privacy page (its path is ADR-0007's), or the fallback. Built from the
 * parsed address, so a spelling URL accepts (`https:x.example`) still gives an absolute link.
 */
export function privacyUrl(site: string | undefined): string {
  if (site === undefined || site === "") return PRIVACY_FALLBACK;
  const url = new URL(site);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/privacy.html`;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text safe inside an element or a quoted attribute. Every name, target and maker goes through it. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export interface StatsRow {
  link: StoredLink;
  /** The last DAYS UTC days, oldest first, today last. */
  days: number[];
  recent: number;
  total: number;
  expired: boolean;
}

/** Every link with its counts, busiest over the last DAYS days first, then by total, then by name. */
export function statsRows(links: LinkStore, now: Date): StatsRow[] {
  const window = Array.from({ length: DAYS }, (_, i) => utcDay(new Date(now.getTime() - (DAYS - 1 - i) * 86_400_000)));
  const rows = links.list().map((link) => {
    // Through the store, which adds today's follows not yet written (ADR-0014).
    const counted = new Map(links.dailyCounts(link.id).map(({ day, count }) => [day, count]));
    const days = window.map((day) => counted.get(day) ?? 0);
    return {
      link,
      days,
      recent: days.reduce((sum, n) => sum + n, 0),
      total: [...counted.values()].reduce((sum, n) => sum + n, 0),
      expired: isExpired({ expiresAt: expiryOf(link) }, now),
    };
  });
  return rows.sort(
    (a, b) => b.recent - a.recent || b.total - a.total || (a.link.name < b.link.name ? -1 : a.link.name > b.link.name ? 1 : 0),
  );
}

/** "never", the UTC date of an end-of-day expiry, or its UTC date and minute. */
export function expiryText(expiresAt: string | null): string {
  if (expiresAt === null) return "never";
  if (expiresAt.endsWith("T23:59:59.999Z")) return expiresAt.slice(0, 10);
  return `${expiresAt.slice(0, 10)} ${expiresAt.slice(11, 16)} UTC`;
}

const LINE_W = 130;
const LINE_H = 24;

/** The 14-day line as inline SVG, scaled to the row's own busiest day; the counts are its label. */
export function sparkline(days: number[]): string {
  const max = Math.max(...days);
  const step = LINE_W / (days.length - 1);
  const points = days
    .map((n, i) => `${(i * step).toFixed(1)},${(LINE_H - 2 - (max === 0 ? 0 : (n / max) * (LINE_H - 4))).toFixed(1)}`)
    .join(" ");
  const label = `Last ${days.length} days, oldest first: ${days.join(", ")}`;
  return (
    `<svg class="spark" viewBox="0 0 ${LINE_W} ${LINE_H}" width="${LINE_W}" height="${LINE_H}" role="img" aria-label="${label}">` +
    `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`
  );
}

function rowHtml({ link, days, total, expired }: StatsRow): string {
  const name = escapeHtml(link.name);
  const target = escapeHtml(link.target);
  const madeBy = link.madeBy === "" ? "—" : escapeHtml(link.madeBy);
  const expires = expired ? '<span class="gone">expired</span>' : escapeHtml(expiryText(link.expiresAt));
  return (
    `<tr class="link${expired ? " expired" : ""}" data-name="${name}" data-target="${target}">` +
    `<td class="name">${name}</td>` +
    `<td class="copy-cell"><button type="button" class="copy" data-name="${name}">Copy</button></td>` +
    `<td class="target" title="${target}">${target}</td>` +
    `<td class="made-by">${madeBy}</td>` +
    `<td class="expires">${expires}</td>` +
    `<td class="line">${sparkline(days)}</td>` +
    `<td class="total">${total}</td>` +
    `</tr>`
  );
}

export function statsPage(rows: StatsRow[], site: string | undefined): string {
  const body =
    rows.length === 0
      ? '<tr class="empty"><td colspan="7">No links yet. <a href="#make-a-link">Make one from the command line.</a></td></tr>'
      : rows.map(rowHtml).join("\n") + '\n<tr id="no-match" hidden><td colspan="7">No links match.</td></tr>';
  const privacy = escapeHtml(privacyUrl(site));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Linkling — our links</title>
<link rel="stylesheet" href="/-/stats.css">
<script src="/-/stats.js" defer></script>
</head>
<body>
<main>
<h1>Linkling — our links</h1>
<p class="filter"><label for="filter">Filter links</label>
<input id="filter" type="search" placeholder="Filter links… (name or target)" autocomplete="off" spellcheck="false"></p>
<table id="links">
<thead><tr><th colspan="2" scope="colgroup">Short link</th><th scope="col">Goes to</th><th scope="col">Made by</th><th scope="col">Expires</th><th scope="col">Last ${DAYS} days</th><th scope="col" class="total">Total</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
<p class="sorted">Sorted: busiest over the last ${DAYS} days first.</p>
<ul class="notes">
<li>Expired links stay listed, greyed, so their old counts are still visible.</li>
<li>A count is one follow of a link on one UTC day, and nothing about who clicked is kept (<a href="${privacy}">privacy</a>). ${PREVIEW_SENTENCE}</li>
</ul>
<section id="make-a-link">
<h2>Make a link</h2>
<p>From the command line, with the <code>linkling</code> command set up as the <a href="https://github.com/jpslav/linkling2-api#readme">linkling-api README</a> says:</p>
<pre><code>linkling make https://example.com/a/long/address --name q3-plan</code></pre>
<p>Leave out <code>--name</code> and Linkling makes one up. <code>--expires 7d</code> or <code>--expires 2026-10-03</code> sets when it stops working; <code>--by</code> sets the Made by name, which is otherwise your login name.</p>
</section>
</main>
<footer><a href="${privacy}">Privacy</a> · <a href="#make-a-link">Make a link (CLI)</a></footer>
</body>
</html>
`;
}

export const STATS_CSS = `:root { color-scheme: light dark; --muted: #6b6b6b; --line: #d0d0d0; --red: #b3261e; }
body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 1.5rem; }
main { max-width: 72rem; }
h1 { font-weight: 600; margin: 0 0 1rem; }
.filter label { position: absolute; left: -10000px; }
#filter { font: inherit; width: min(28rem, 100%); padding: .4rem .6rem; border: 1px solid; border-radius: 3px; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; table-layout: fixed; }
th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
th:nth-child(1) { width: 12rem; } th:nth-child(3) { width: 8rem; } th:nth-child(4) { width: 7rem; } th:nth-child(5) { width: 9rem; } th:nth-child(6) { width: 9.5rem; }
td.name { font-weight: 600; overflow-wrap: anywhere; }
td.copy-cell { width: 4.5rem; }
td.target { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.total { text-align: right; width: 5rem; font-variant-numeric: tabular-nums; }
button.copy { font: inherit; font-size: .85em; padding: .1rem .5rem; cursor: pointer; }
tr.expired td { color: var(--muted); }
tr.expired td.name, tr.expired td.line { opacity: .6; }
.gone { color: var(--red); }
.sorted { color: var(--muted); font-size: .85em; text-align: right; margin: .25rem 0 1rem; }
.notes { color: var(--muted); padding-left: 1.2rem; }
pre { overflow-x: auto; padding: .6rem; border: 1px solid var(--line); }
footer { margin-top: 2rem; padding-top: .75rem; border-top: 1px solid var(--line); max-width: 72rem; }
.offscreen { position: absolute; left: -10000px; }
`;

export const STATS_JS = `"use strict";
// Filter as you type: a row stays when its short name or target contains the text.
const filter = document.getElementById("filter");
const rows = [...document.querySelectorAll("tr.link")];
const noMatch = document.getElementById("no-match");
function applyFilter() {
  const text = filter.value.trim().toLowerCase();
  let shown = 0;
  for (const row of rows) {
    const hit = row.dataset.name.toLowerCase().includes(text) || row.dataset.target.toLowerCase().includes(text);
    row.hidden = !hit;
    if (hit) shown++;
  }
  if (noMatch) noMatch.hidden = shown !== 0;
}
filter.addEventListener("input", applyFilter);
applyFilter();

// Copy the short link as this browser reaches the service. The Clipboard API exists only in
// secure contexts (https, or localhost); elsewhere the older copy command does it.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "offscreen";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("copy refused");
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button.copy");
  if (!button) return;
  const say = (label) => {
    button.textContent = label;
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };
  copyText(location.origin + "/" + button.dataset.name).then(() => say("Copied"), () => say("Copy failed"));
});
`;

// Nothing but this origin's own stylesheet and script, and no framing (ADR-0015).
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(reply: FastifyReply, type: string, body: string): FastifyReply {
  return reply
    .code(200)
    .headers({
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": CSP,
    })
    .type(type)
    .send(body);
}

export function registerStats(app: FastifyInstance, { links, now, site }: StatsDeps): void {
  app.get("/-/stats", async (_request, reply) =>
    send(reply, "text/html; charset=utf-8", statsPage(statsRows(links, now()), site)),
  );
  app.get("/-/stats.css", async (_request, reply) => send(reply, "text/css; charset=utf-8", STATS_CSS));
  app.get("/-/stats.js", async (_request, reply) => send(reply, "text/javascript; charset=utf-8", STATS_JS));
}
