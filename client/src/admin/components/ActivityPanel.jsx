import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import { Badge, Button, Card, EmptyRow, Select, TableWrap, Td, Th } from './ui.jsx';
import { fullDate, humanizeEvent, timeAgo } from '../lib/format.js';

/**
 * The audit trail: admin actions and auth events, newest first. Read-only — the
 * server writes these rows and there is no way to edit or delete them here.
 *
 * The event filter is component state rather than store state: it's a view of
 * the already-fetched page, so filtering never needs another request.
 */

const DETAIL_MAX_CHARS = 120;

function eventTone(event) {
  if (event === 'admin_forbidden') return 'bad';
  if (String(event).includes('key')) return 'warn';
  return 'accent';
}

/** Metadata object -> "slug=openai count=3" on one line. */
function formatMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  return Object.entries(metadata)
    .map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${text}`;
    })
    .join('  ');
}

export default function ActivityPanel() {
  const auditEntries = useAdminStore((s) => s.auditEntries);
  const refreshAudit = useAdminStore((s) => s.refreshAudit);
  const showToast = useAdminStore((s) => s.showToast);
  const [event, setEvent] = useState('all');
  const [loading, setLoading] = useState(false);

  // refreshAudit is a bare fetch (no `run()` wrapper), so the failure path is
  // ours to surface.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      await refreshAudit();
    } catch (err) {
      showToast('error', err.message || 'Could not load the activity log');
    } finally {
      setLoading(false);
    }
  }, [refreshAudit, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const events = useMemo(
    () => [...new Set(auditEntries.map((entry) => entry.event))].sort(),
    [auditEntries]
  );

  // A refresh can drop the event that was selected; fall back to "all" so the
  // <select> never shows a value it has no option for.
  const active = event !== 'all' && !events.includes(event) ? 'all' : event;
  const rows = active === 'all' ? auditEntries : auditEntries.filter((e) => e.event === active);

  return (
    <Card
      title="Activity"
      description={
        auditEntries.length
          ? `Showing ${rows.length} of the ${auditEntries.length} most recent events.`
          : 'Admin and authentication events, newest first.'
      }
      actions={
        <>
          <div className="w-52">
            <Select
              value={active}
              onChange={setEvent}
              options={[
                { value: 'all', label: 'All events' },
                ...events.map((name) => ({ value: name, label: humanizeEvent(name) })),
              ]}
            />
          </div>
          <Button icon={RefreshCw} size="sm" busy={loading} onClick={load}>
            Refresh
          </Button>
        </>
      }
    >
      <TableWrap>
        <table className="w-full min-w-[52rem] border-collapse">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Event</Th>
              <Th>Who</Th>
              <Th>IP</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={5}>
                {auditEntries.length ? 'No events match this filter.' : 'Nothing has been logged yet.'}
              </EmptyRow>
            ) : (
              rows.map((entry) => {
                const details = formatMetadata(entry.metadata);
                const truncated = details.length > DETAIL_MAX_CHARS;
                return (
                  <tr key={entry._id}>
                    <Td className="whitespace-nowrap align-top text-zinc-400">
                      <span title={fullDate(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
                    </Td>
                    <Td className="align-top">
                      <Badge tone={eventTone(entry.event)} title={entry.event}>
                        {humanizeEvent(entry.event)}
                      </Badge>
                    </Td>
                    <Td className="align-top">
                      {entry.email || <span className="text-zinc-600">—</span>}
                    </Td>
                    <Td className="align-top font-mono text-[11px] text-zinc-500">
                      {entry.ip || '—'}
                    </Td>
                    <Td className="max-w-[26rem] align-top">
                      {details ? (
                        <span
                          title={truncated ? details : undefined}
                          className="block break-words font-mono text-[11px] leading-5 text-zinc-500"
                        >
                          {truncated ? `${details.slice(0, DETAIL_MAX_CHARS - 1)}…` : details}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
