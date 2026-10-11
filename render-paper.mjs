import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, 'Login_Security_Implementation_Paper.md'), 'utf8');
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function inline(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

let sheets = [[]];
const lines = source.split(/\r?\n/);
for (let index = 0; index < lines.length; index++) {
  const line = lines[index].trim();
  if (!line) continue;
  if (line === '\\newpage') { if (sheets.at(-1).length) sheets.push([]); continue; }
  if (line.startsWith('|') && lines[index + 1]?.trim().startsWith('|')) {
    const rows = [];
    while (index < lines.length && lines[index].trim().startsWith('|')) {
      const cells = lines[index].trim().slice(1, -1).split('|').map(c => c.trim());
      if (!cells.every(c => /^:?-+:?$/.test(c))) rows.push(cells);
      index++;
    }
    index--;
    const head = rows.shift() ?? [];
    sheets.at(-1).push(`<table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    continue;
  }
  const heading = line.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    sheets.at(-1).push(`<h${level}>${inline(heading[2])}</h${level}>`);
  } else if (line.startsWith('---')) {
    sheets.at(-1).push('<hr>');
  } else {
    sheets.at(-1).push(`<p>${inline(line)}</p>`);
  }
}

const body = sheets.map((sheet, index) => `<article class="sheet"><div class="running-head">SECURE WORKSPACE <span>IMPLEMENTATION PAPER</span></div><section>${sheet.join('\n')}</section><div class="running-foot">CONFIDENTIAL DESIGN PROPOSAL <span>${index + 1} / ${sheets.length}</span></div></article>`).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure User Login — Implementation Paper</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#e9eeec;color:#18313d;font:9.15pt/1.31 Arial,Helvetica,sans-serif}.sheet{position:relative;width:210mm;height:297mm;padding:17mm 18mm 17mm;background:#fff;margin:10mm auto;box-shadow:0 2mm 8mm #18313d20;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}.running-head,.running-foot{display:flex;justify-content:space-between;color:#55706f;font-size:7pt;font-weight:bold;letter-spacing:.14em}.running-head{border-bottom:1px solid #d6e0dd;padding-bottom:3mm;margin-bottom:5mm}.running-foot{position:absolute;bottom:9mm;left:18mm;right:18mm;border-top:1px solid #d6e0dd;padding-top:3mm}h1{font-size:18pt;line-height:1.08;color:#153b4b;margin:0 0 2mm;letter-spacing:-.03em}h2{font-size:10pt;color:#176b55;margin:1mm 0 3mm}h3{font-size:10pt;color:#176b55;margin:3.2mm 0 1mm}p{margin:0 0 2.1mm;text-align:justify}table{width:100%;border-collapse:collapse;margin:2mm 0 3mm;font-size:8.2pt}th{background:#eaf2ef;text-align:left;color:#173b35}td,th{border:1px solid #dbe3e5;padding:1.5mm 2mm;vertical-align:top}a{color:#176b55;text-decoration:none;overflow-wrap:anywhere}code{font-size:8pt}strong{color:#193a46}hr{border:0;border-top:1px solid #dbe3e5;margin:3mm 0}.sheet p:last-child{margin-bottom:0}@media print{html,body{background:white}.sheet{margin:0;box-shadow:none}}
</style></head><body>${body}</body></html>`;
const output = join(root, 'Login_Security_Implementation_Paper.html');
writeFileSync(output, html, 'utf8');
console.log(output);
