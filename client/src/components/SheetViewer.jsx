import { useMemo, useState } from 'react';
import { EyeOff, Sigma, Table2 } from 'lucide-react';
import clsx from 'clsx';
import { parseSheetText, numericColumns } from '../lib/sheetView.js';

/**
 * Spreadsheet preview: Excel-style sheet tabs along the bottom, a sticky header
 * row and a sticky row-number gutter.
 *
 * It renders the SERVER'S text, not the original file — the binary is discarded
 * at upload (server/src/lib/sheet.js), so this is by definition exactly what the
 * model was given. That is the useful thing to show: if an answer looks wrong,
 * this is where you see whether the AI ever had the right numbers.
 */
export default function SheetViewer({ text, name }) {
  const book = useMemo(() => parseSheetText(text), [text]);
  const [active, setActive] = useState(0);
  const sheet = book.sheets[active];

  const numeric = useMemo(() => (sheet ? numericColumns(sheet) : []), [sheet]);

  if (!sheet) {
    return (
      <div className="flex h-full w-full max-w-6xl items-center justify-center rounded-xl border border-white/10 bg-surface-900">
        <p className="text-sm text-zinc-400">This spreadsheet had no readable rows.</p>
      </div>
    );
  }

  const notes = sheet.notes.filter((n) => !n.startsWith('Legend:'));

  return (
    <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-white/10 bg-surface-900 shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <Table2 size={15} className="text-emerald-400" />
        <span className="truncate text-sm font-medium text-zinc-200">{book.title || name}</span>
        <span className="text-[11px] text-zinc-500">{sheet.meta}</span>
        <span className="ml-auto shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[10.5px] text-zinc-500">
          this is the text the model received
        </span>
      </div>

      {notes.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2 text-[11px] text-zinc-400">
          {notes.map((note, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {note.startsWith('Formulas:') ? (
                <Sigma size={11} className="shrink-0 text-violet-400" />
              ) : /hidden/i.test(note) ? (
                <EyeOff size={11} className="shrink-0 text-amber-400" />
              ) : null}
              <span className="font-mono">{note}</span>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              {sheet.header.map((cell, c) => (
                <th
                  key={c}
                  className={clsx(
                    // Sticky both ways: the header stays while you scroll down,
                    // and the row gutter stays while you scroll right.
                    'sticky top-0 z-20 whitespace-nowrap border-b border-r border-white/[0.08] bg-surface-850 px-3 py-2 text-left align-bottom',
                    c === 0 && 'left-0 z-30 w-14 text-center'
                  )}
                >
                  {cell.col && (
                    <span className="block font-mono text-[10px] font-normal text-zinc-600">
                      {cell.col}
                    </span>
                  )}
                  <span className="font-semibold text-zinc-200">{cell.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) =>
              row.omitted ? (
                <tr key={`gap-${r}`}>
                  <td
                    colSpan={sheet.header.length || 1}
                    className="border-b border-white/[0.06] bg-amber-500/[0.05] px-3 py-2 text-center text-[11px] italic text-amber-300/80"
                  >
                    {row.note || 'rows omitted'}
                  </td>
                </tr>
              ) : (
                <tr key={row.number ?? r} className="group">
                  <td className="sticky left-0 z-10 w-14 border-b border-r border-white/[0.08] bg-surface-850 px-2 py-1.5 text-center font-mono text-[11px] text-zinc-500">
                    {row.number}
                  </td>
                  {sheet.header.slice(1).map((_, c) => (
                    <td
                      key={c}
                      className={clsx(
                        'max-w-[420px] truncate whitespace-pre-wrap border-b border-r border-white/[0.05] px-3 py-1.5 text-zinc-300 group-hover:bg-white/[0.03]',
                        numeric[c] && 'text-right font-mono tabular-nums'
                      )}
                      title={row.cells[c] || ''}
                    >
                      {row.cells[c]}
                    </td>
                  ))}
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>

      {/* Sheet tabs, along the bottom where a spreadsheet puts them. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/[0.07] bg-surface-850 px-2 py-1.5">
        {book.sheets.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(i)}
            className={clsx(
              'shrink-0 rounded-t-md border-b-2 px-3 py-1.5 text-xs transition-colors',
              i === active
                ? 'border-emerald-400 bg-white/[0.06] font-medium text-zinc-100'
                : 'border-transparent text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300'
            )}
          >
            {s.name}
          </button>
        ))}
        {book.omitted.map((label, i) => (
          <span
            key={`omitted-${i}`}
            title="This sheet was not sent to the model"
            className="flex shrink-0 items-center gap-1 rounded-t-md px-3 py-1.5 text-xs italic text-zinc-600"
          >
            <EyeOff size={11} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
