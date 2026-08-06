/**
 * Turns the stored spreadsheet text back into a grid the viewer can render.
 *
 * The server converts an upload to text once, at upload time, and throws the
 * binary away (server/src/lib/sheet.js) — so that text is the only copy that
 * will ever exist, and it is exactly what the model was given. Rendering it,
 * rather than a second parse of the original file, means the viewer can never
 * show something prettier than what the AI actually read.
 *
 * Keep in step with `renderSheet` on the server: `## Sheet i/N — "Name"` opens a
 * block, `| row | A: Header | …` is the header, and `|` rows follow.
 */

/** Undoes the escaping renderSheet applies so a cell can't break the grid. */
const unescapeCell = (value) => value.replace(/\\\|/g, '|').replace(/ ⏎ /g, '\n');

const splitRow = (line) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => unescapeCell(cell.trim()));

/**
 * `A: Region` -> `{ col: 'A', label: 'Region' }`. A bare `A` is a sheet the
 * server decided has no header row, so there is a letter and nothing to label it
 * with; anything else is kept as written.
 */
function parseHeaderCell(raw) {
  const m = /^([A-Z]{1,3}):\s*([\s\S]*)$/.exec(raw);
  if (m) return { col: m[1], label: m[2] };
  if (/^[A-Z]{1,3}$/.test(raw)) return { col: raw, label: '' };
  return { col: null, label: raw };
}

const isRule = (line) => /^\s*\|[\s|:-]+\|\s*$/.test(line);

export function parseSheetText(text) {
  const src = String(text || '');
  const lines = src.split('\n');

  const title = /^\[Content of [^"]*"([^"]+)"/.exec(lines[0] || '')?.[1] || null;
  const manifest = lines.find((l) => l.startsWith('Sheets: '))?.slice(8) || '';
  // Sheets the server skipped (hidden, over the limit, unreadable) still appear
  // in the manifest — surfacing them is the point, since a hidden sheet the user
  // forgot about is exactly what they would want to know was left out.
  const omitted = manifest
    .split(' · ')
    .filter((part) => part.includes('— omitted'))
    .map((part) => part.replace('— omitted', '').trim());

  const sheets = [];
  let current = null;
  let headerLine = null;

  for (const line of lines) {
    const head = /^## Sheet \d+\/\d+ — "([\s\S]*?)"\s*(?:\(([^)]*)\))?/.exec(line);
    if (head) {
      current = { name: head[1], meta: head[2] || '', notes: [], header: [], rows: [] };
      headerLine = null;
      sheets.push(current);
      continue;
    }
    if (!current) continue;

    if (isRule(line)) continue;
    if (line.startsWith('|')) {
      if (headerLine === null) {
        headerLine = line;
        current.header = splitRow(line).map(parseHeaderCell);
        continue;
      }
      // renderSheet reprints the header every 50 rows so a long grid stays
      // readable for the model; the viewer has a sticky header instead.
      if (line === headerLine) continue;
      const cells = splitRow(line);
      const [first, ...rest] = cells;
      if (first === '…') {
        current.rows.push({ omitted: true, note: rest.filter(Boolean).join(' ') });
        continue;
      }
      current.rows.push({ number: first, cells: rest });
      continue;
    }
    if (line.trim()) current.notes.push(line.trim());
  }

  return { title, omitted, sheets: sheets.filter((s) => s.header.length || s.rows.length) };
}

/** True when every value in a column parses as a number — those get right-aligned. */
export function numericColumns(sheet) {
  const width = sheet.header.length ? sheet.header.length - 1 : 0;
  const numeric = [];
  for (let c = 0; c < width; c++) {
    let seen = 0;
    let numbers = 0;
    for (const row of sheet.rows) {
      if (row.omitted) continue;
      const value = (row.cells[c] ?? '').trim();
      if (!value) continue;
      seen += 1;
      if (/^-?[\d,]+(\.\d+)?%?$/.test(value)) numbers += 1;
    }
    numeric.push(seen > 0 && numbers === seen);
  }
  return numeric;
}
