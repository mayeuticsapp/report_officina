import { DailyReport, WorkerDailyStats } from "@/src/api/client";

/**
 * Export report su PC: apre una finestra di stampa con il report impaginato.
 * Da lì l'utente può salvare come PDF (nativo del browser) o stampare su carta.
 * Solo web — su nativo si usa Share.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Converte il markdown essenziale della narrativa AI in HTML. */
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    let line = esc(raw.trim());
    if (!line) {
      if (inList) { out.push("</ul>"); inList = false; }
      continue;
    }
    // grassetto **x**
    line = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (/^#{1,4}\s/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h3>${line.replace(/^#{1,4}\s*/, "")}</h3>`);
    } else if (/^[-*•]\s/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${line.replace(/^[-*•]\s*/, "")}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${line}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function fmtMin(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

export function printReport(r: DailyReport, workerFilter?: WorkerDailyStats): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const target = workerFilter ? [workerFilter] : r.workers;
  const title = workerFilter
    ? `Report ${workerFilter.full_name} — ${r.date}`
    : `Report Officina — ${r.date}`;

  const workersHtml = target
    .map((w) => {
      const rows = w.orders
        .map(
          (o) => `<tr>
            <td>${esc(o.plate)}</td>
            <td>${esc(o.vehicle)}</td>
            <td>${esc(o.customer)}</td>
            <td class="num">${o.events_count}</td>
            <td class="num">${fmtMin(o.minutes_worked)}</td>
          </tr>`
        )
        .join("");
      return `
        <div class="worker">
          <h2>${esc(w.full_name)} <span class="username">@${esc(w.username)}</span></h2>
          <div class="stats">Eventi: <strong>${w.events_count}</strong> · Ore lavorate: <strong>${fmtMin(w.minutes_worked)}</strong></div>
          ${
            w.orders.length
              ? `<table>
                  <thead><tr><th>Targa</th><th>Veicolo</th><th>Cliente</th><th class="num">Eventi</th><th class="num">Tempo</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>`
              : `<p class="muted">Nessuna commessa lavorata.</p>`
          }
        </div>`;
    })
    .join("");

  const narrativeHtml =
    !workerFilter && r.narrative
      ? `<div class="narrative"><h2>Analisi AI</h2>${mdToHtml(r.narrative)}</div>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 32px; }
  header { border-bottom: 3px solid #111; padding-bottom: 12px; margin-bottom: 20px; }
  header .brand { font-size: 11px; letter-spacing: 4px; font-weight: 700; color: #666; }
  header h1 { margin: 4px 0 0; font-size: 26px; letter-spacing: -0.5px; }
  header .date { color: #666; font-size: 13px; margin-top: 4px; }
  .totals { display: flex; gap: 24px; margin: 16px 0 24px; }
  .totals div { border: 1px solid #ddd; padding: 10px 16px; }
  .totals .label { font-size: 10px; letter-spacing: 2px; color: #666; font-weight: 700; }
  .totals .value { font-size: 20px; font-weight: 800; }
  .worker { margin-bottom: 22px; page-break-inside: avoid; }
  .worker h2 { font-size: 16px; margin: 0 0 4px; border-left: 4px solid #111; padding-left: 8px; }
  .username { color: #888; font-weight: 400; font-size: 12px; }
  .stats { font-size: 13px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f4f4f4; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
  td.num, th.num { text-align: right; }
  .narrative { margin-top: 28px; border-top: 2px solid #111; padding-top: 12px; page-break-inside: auto; }
  .narrative h2 { font-size: 16px; }
  .narrative h3 { font-size: 13px; letter-spacing: 1px; text-transform: uppercase; margin: 14px 0 6px; }
  .narrative p, .narrative li { font-size: 13px; line-height: 1.5; margin: 4px 0; }
  .muted { color: #888; font-style: italic; font-size: 12px; }
  footer { margin-top: 32px; border-top: 1px solid #ddd; padding-top: 8px; font-size: 10px; color: #999; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
  <header>
    <div class="brand">OFFICINA — GESTIONE LAVORI</div>
    <h1>${esc(workerFilter ? `Report ${workerFilter.full_name}` : "Report giornaliero")}</h1>
    <div class="date">Data: ${esc(r.date)} — generato il ${new Date().toLocaleString("it-IT")}</div>
  </header>
  <div class="totals">
    <div><div class="label">EVENTI</div><div class="value">${r.total_events}</div></div>
    <div><div class="label">ORE TOTALI</div><div class="value">${fmtMin(r.total_minutes)}</div></div>
    <div><div class="label">COMMESSE</div><div class="value">${r.orders_touched}</div></div>
  </div>
  ${workersHtml}
  ${narrativeHtml}
  <footer>Report Officina — app.autoservicevalente.it</footer>
  <script>window.onload = () => { window.print(); };</script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return false; // popup bloccato
  win.document.write(html);
  win.document.close();
  return true;
}
