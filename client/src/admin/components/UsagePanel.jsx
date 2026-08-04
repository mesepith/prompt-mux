import { useEffect } from 'react';
import {
  ChevronRight,
  CornerDownRight,
  Eye,
  FileText,
  GitFork,
  Info,
  Loader2,
  Paperclip,
  Share2,
  Users,
  Wand2,
} from 'lucide-react';
import clsx from 'clsx';
import { useAdminStore } from '../useAdminStore.js';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyRow,
  Field,
  Mono,
  Spinner,
  StatTile,
  TableWrap,
  Td,
  Th,
  TextInput,
} from './ui.jsx';
import { fullDate, timeAgo } from '../lib/format.js';

/**
 * Usage reporting: people -> that person's chats -> one chat's messages, priced
 * from the registry's current prices. The deepest loaded level is what renders,
 * and the breadcrumb walks back up by clearing store state.
 *
 * Two facts from the API shape most of this view:
 *  - one assistant message can bill TWO models (the reply model, plus a vision
 *    model when the chat model can't see images), so the leaf level renders the
 *    vision leg as its own sub-row — that is the only place the second call is
 *    visible;
 *  - a null cost means "no price on file", not "free", so nulls stay em dashes
 *    and never collapse into $0.
 */

/** Counts and token columns: a number, or an em dash — never a fake zero. */
function num(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : '—';
}

/**
 * Money for a cost report, not for a price list: single messages cost fractions
 * of a cent, so sub-cent values keep the 6 decimals the server rounds to. The
 * three states the API separates on purpose stay separate — null is "no price
 * known", 0 is a genuinely free model.
 */
function money(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return 'Free';
  if (n < 0.000001) return '<$0.000001';
  if (n < 0.01) return `$${n.toFixed(6).replace(/0+$/, '')}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function Dash() {
  return <span className="text-zinc-600">—</span>;
}

/** Fallback naming for an ownerKey when the people list isn't loaded to name it. */
function describeOwnerKey(key) {
  const raw = String(key || '');
  if (raw === 'legacy') return 'Before user accounts existed';
  if (raw.startsWith('session:')) return `Anonymous · ${raw.slice(8, 16)}`;
  if (raw.startsWith('user:')) return `User ${raw.slice(5)}`;
  return raw || 'Unknown';
}

function KindBadge({ kind, role }) {
  if (kind === 'user') {
    return role === 'admin' ? <Badge tone="accent">admin</Badge> : null;
  }
  if (kind === 'session') return <Badge>anonymous</Badge>;
  if (kind === 'legacy') return <Badge tone="warn">unattributed</Badge>;
  return <Badge tone="warn">no account</Badge>;
}

/** A row's cost is a floor, not a total, when one of its models has no price. */
function UnpricedBadge({ models }) {
  if (!models || models.length === 0) return null;
  return (
    <Badge
      tone="warn"
      title={`No price on file for: ${models.join(', ')}. This row's cost is a floor, not the whole bill.`}
    >
      {models.length} unpriced
    </Badge>
  );
}

/**
 * Flags a person or chat whose spend includes a separately billed vision call, so
 * the two-model billing is discoverable before drilling all the way down.
 */
function VisionBadge({ byModel }) {
  const legs = (byModel || []).filter((m) => m.kind === 'vision');
  if (legs.length === 0) return null;
  const detail = legs
    .map((m) => `${m.modelId} · ${m.messages} message(s) · ${money(m.costUsd)}`)
    .join('\n');
  return (
    <Badge
      tone="info"
      icon={Eye}
      title={`Some messages also billed a separate vision model to read their images:\n${detail}`}
    >
      vision billed
    </Badge>
  );
}

function rowKeyDown(open) {
  return (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };
}

const CLICKABLE_ROW = 'cursor-pointer transition-colors hover:bg-white/[0.03]';

/**
 * Cost tile. An unpriced model makes the figure a floor rather than the bill, so
 * that is said on the tile instead of only in the row that caused it.
 */
function CostTile({ totals }) {
  const unpriced = (totals.unpricedModels || []).length;
  const floor = totals.fullyPriced === false;
  return (
    <StatTile
      label="Cost"
      value={money(totals.costUsd)}
      tone={floor ? 'warn' : 'default'}
      hint={
        floor
          ? unpriced
            ? `${unpriced} model(s) have no price`
            : 'a model here has no price'
          : 'at today’s prices'
      }
    />
  );
}

function TokenTiles({ totals }) {
  return (
    <>
      <StatTile label="Input" value={num(totals.inputTokens)} hint="tokens" />
      <StatTile label="Output" value={num(totals.outputTokens)} hint="tokens" />
      <StatTile
        label="Reasoning"
        value={num(totals.reasoningTokens)}
        hint="inside output, not extra"
      />
    </>
  );
}

/** Token columns, in the same order at every level. */
/**
 * Where a person's messages came from. One address is the ordinary case; several
 * is the interesting one (a shared account, or one person on several networks), so
 * the count leads and the rest are in the tooltip.
 */
function IpCell({ ips, count, fallback }) {
  const list = Array.isArray(ips) ? ips : [];
  // `count` is the true number of distinct addresses; `list` is capped for display,
  // so "+N more" must come from the count or it silently saturates.
  const total = typeof count === 'number' && count > list.length ? count : list.length;
  if (!list.length) {
    return (
      <Td className="align-top whitespace-nowrap font-mono text-[11px] text-zinc-500">
        {fallback ? (
          <span title="From the account's last sign-in; these messages predate per-message IP recording.">
            {fallback}
          </span>
        ) : (
          <span title="Recorded only for messages sent after IP logging was added.">—</span>
        )}
      </Td>
    );
  }
  const [first] = list;
  const hidden = total - 1;
  return (
    <Td className="align-top whitespace-nowrap font-mono text-[11px] text-zinc-300">
      <span title={list.map((i) => `${i.ip} · ${i.messages} message(s)`).join('\n')}>
        {first.ip}
        {hidden > 0 && (
          <span className="ml-1 font-sans text-[10.5px] text-amber-300">+{hidden} more</span>
        )}
      </span>
    </Td>
  );
}

function TokenCells({ input, output, reasoning, total }) {
  return (
    <>
      <Td align="right" className="tabular-nums text-zinc-400">
        {num(input)}
      </Td>
      <Td align="right" className="tabular-nums text-zinc-400">
        {num(output)}
      </Td>
      <Td align="right" className="tabular-nums text-zinc-500">
        {num(reasoning)}
      </Td>
      {total !== undefined && (
        <Td align="right" className="tabular-nums text-zinc-300">
          {num(total)}
        </Td>
      )}
    </>
  );
}

function Crumb({ children, onClick, current }) {
  if (current) {
    return <span className="min-w-0 truncate font-medium text-zinc-200">{children}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 shrink-0 truncate text-zinc-500 transition-colors hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

/** Label/value pair for the leaf header. */
function Detail({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-sm text-zinc-300">
        {children}
      </div>
    </div>
  );
}

// ---------- level 1: people ----------

function PeopleLevel({ usage, onOpen }) {
  const setUsageWindow = useAdminStore((s) => s.setUsageWindow);
  const loadUsage = useAdminStore((s) => s.loadUsage);
  const usageWindow = useAdminStore((s) => s.usageWindow);
  const usageLoading = useAdminStore((s) => s.usageLoading);

  const totals = usage.totals || {};
  const users = usage.users || [];
  const windowed = Boolean(usageWindow.from || usageWindow.to);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CostTile totals={totals} />
        <StatTile label="Billed messages" value={num(totals.messages)} hint="assistant replies" />
        <TokenTiles totals={totals} />
        <StatTile icon={Users} label="People" value={num(users.length)} hint="rows below" />
      </div>

      <Card
        title="Who spent what"
        description="One row per signed-in user, anonymous session, or unattributed bucket. Highest cost first. Open a row for that person’s chats."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From" className="w-40">
              <TextInput
                type="date"
                value={usageWindow.from}
                onChange={(from) => setUsageWindow({ ...usageWindow, from })}
              />
            </Field>
            <Field label="To" className="w-40">
              <TextInput
                type="date"
                value={usageWindow.to}
                onChange={(to) => setUsageWindow({ ...usageWindow, to })}
              />
            </Field>
            <Button variant="primary" busy={usageLoading} onClick={() => loadUsage()}>
              Apply
            </Button>
            <Button
              variant="ghost"
              disabled={!windowed || usageLoading}
              onClick={() => {
                setUsageWindow({ from: '', to: '' });
                loadUsage();
              }}
            >
              Clear
            </Button>
          </div>
        }
      >
        <TableWrap>
          <table className="w-full min-w-[64rem] border-collapse">
            <thead>
              <tr>
                <Th>Who</Th>
                <Th align="right">
                  <span title="Every chat this person owns — not only the ones with activity in the selected dates.">
                    Chats
                  </span>
                </Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                <Th align="right">Reasoning</Th>
                <Th align="right">Total tokens</Th>
                <Th align="right">Cost</Th>
                <Th>IP</Th>
                <Th>Last active</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <EmptyRow colSpan={10}>
                  {windowed
                    ? 'No messages were billed in these dates.'
                    : 'Nothing has been billed yet.'}
                </EmptyRow>
              ) : (
                users.map((row) => (
                  <tr
                    key={row.ownerKey}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(row.ownerKey)}
                    onKeyDown={rowKeyDown(() => onOpen(row.ownerKey))}
                    className={CLICKABLE_ROW}
                  >
                    <Td className="align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-200">{row.label}</span>
                        <KindBadge kind={row.kind} role={row.role} />
                        <VisionBadge byModel={row.byModel} />
                        <UnpricedBadge models={row.unpricedModels} />
                      </div>
                      {row.note && (
                        <div
                          className="mt-1 flex max-w-[34rem] items-start gap-1.5 text-[11px] leading-4 text-zinc-500"
                          title={row.note}
                        >
                          <Info size={11} className="mt-0.5 shrink-0" />
                          <span>{row.note}</span>
                        </div>
                      )}
                    </Td>
                    <Td align="right" className="align-top tabular-nums text-zinc-400">
                      {num(row.chats)}
                    </Td>
                    <TokenCells
                      input={row.inputTokens}
                      output={row.outputTokens}
                      reasoning={row.reasoningTokens}
                      total={row.totalTokens}
                    />
                    <Td align="right" className="align-top tabular-nums font-medium text-zinc-100">
                      {money(row.costUsd)}
                    </Td>
                    <IpCell ips={row.ips} count={row.ipCount} fallback={row.lastIp} />
                    <Td className="align-top whitespace-nowrap text-zinc-400">
                      <span title={fullDate(row.lastActivityAt)}>{timeAgo(row.lastActivityAt)}</span>
                    </Td>
                    <Td className="align-top">
                      <ChevronRight size={13} className="text-zinc-600" />
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}

// ---------- level 2: one person's chats ----------

function ChatsLevel({ owner, ownerKey, chatsRes, windowed, onOpen }) {
  const totals = chatsRes.totals || {};
  const chats = chatsRes.chats || [];
  const label = owner?.label || describeOwnerKey(ownerKey);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">{label}</h2>
              <KindBadge kind={owner?.kind} role={owner?.role} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              {owner?.email && <span>{owner.email}</span>}
              <Mono>{ownerKey}</Mono>
            </div>
            {owner?.note && (
              <p className="mt-2 max-w-[44rem] text-[11px] leading-5 text-zinc-500">{owner.note}</p>
            )}
            {windowed && (
              <p className="mt-2 max-w-[44rem] text-[11px] leading-5 text-amber-300/80">
                The date filter applies to the people list. This view shows every chat this owner
                has, all time.
              </p>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CostTile totals={totals} />
        <StatTile label="Chats" value={num(chats.length)} hint="conversations" />
        <StatTile label="Billed messages" value={num(totals.messages)} hint="assistant replies" />
        <TokenTiles totals={totals} />
      </div>

      <Card
        title="Chats"
        description="Newest activity first. Open a chat to see every message, both billed models and the exact cost."
      >
        <TableWrap>
          <table className="w-full min-w-[76rem] border-collapse">
            <thead>
              <tr>
                <Th>Chat</Th>
                <Th align="right">Messages</Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                <Th align="right">Reasoning</Th>
                <Th align="right">Total</Th>
                <Th align="right">Cost</Th>
                <Th>Parent chat</Th>
                <Th>IP</Th>
                <Th>Started</Th>
                <Th>Last message</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {chats.length === 0 ? (
                <EmptyRow colSpan={12}>This owner has no chats.</EmptyRow>
              ) : (
                chats.map((chat) => (
                  <tr
                    key={chat._id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(chat._id)}
                    onKeyDown={rowKeyDown(() => onOpen(chat._id))}
                    className={CLICKABLE_ROW}
                  >
                    <Td className="max-w-[22rem] align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-zinc-200" title={chat.title}>
                          {chat.title || 'Untitled chat'}
                        </span>
                        {chat.shared && (
                          <Badge tone="info" icon={Share2} title="This chat has a public share link">
                            shared
                          </Badge>
                        )}
                        <VisionBadge byModel={chat.byModel} />
                        <UnpricedBadge models={chat.unpricedModels} />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Mono className="text-[11px]">{String(chat._id)}</Mono>
                        <span className="text-[11px] text-zinc-500">{chat.modelId}</span>
                        {chat.visionModelId && (
                          <span className="text-[11px] text-zinc-500" title="Vision model for images">
                            + {chat.visionModelId}
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td align="right" className="align-top tabular-nums text-zinc-400">
                      {num(chat.messageCount)}
                    </Td>
                    <TokenCells
                      input={chat.inputTokens}
                      output={chat.outputTokens}
                      reasoning={chat.reasoningTokens}
                      total={chat.totalTokens}
                    />
                    <Td align="right" className="align-top tabular-nums font-medium text-zinc-100">
                      {money(chat.costUsd)}
                    </Td>
                    <Td className="align-top">
                      {chat.forkedFrom ? (
                        <span className="inline-flex items-start gap-1.5 text-xs text-zinc-400">
                          <GitFork size={11} className="mt-0.5 shrink-0 text-zinc-500" />
                          {chat.forkedFromTitle ? (
                            <span className="max-w-[16rem] truncate" title={chat.forkedFromTitle}>
                              fork of {chat.forkedFromTitle}
                            </span>
                          ) : (
                            <span
                              className="min-w-0"
                              title="The parent chat belongs to someone else, so only its id is shown."
                            >
                              fork of <Mono className="text-[11px]">{String(chat.forkedFrom)}</Mono>
                            </span>
                          )}
                        </span>
                      ) : (
                        <Dash />
                      )}
                    </Td>
                    {/* Both addresses, but only when they differ — a chat that moved
                        network is worth noticing; one that didn't is just noise. */}
                    <Td className="align-top whitespace-nowrap font-mono text-[11px] text-zinc-300">
                      {chat.ip || chat.lastIp ? (
                        <>
                          <span>{chat.ip || chat.lastIp}</span>
                          {chat.lastIp && chat.ip && chat.lastIp !== chat.ip && (
                            <span
                              className="ml-1 font-sans text-[10.5px] text-amber-300"
                              title={`Started from ${chat.ip}, last written from ${chat.lastIp}`}
                            >
                              → {chat.lastIp}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-zinc-500" title="Recorded only for chats started after IP logging was added.">
                          —
                        </span>
                      )}
                    </Td>
                    <Td className="align-top whitespace-nowrap text-zinc-400">
                      <span title={fullDate(chat.createdAt)}>{timeAgo(chat.createdAt)}</span>
                    </Td>
                    <Td className="align-top whitespace-nowrap text-zinc-400">
                      <span title={fullDate(chat.lastMessageAt)}>{timeAgo(chat.lastMessageAt)}</span>
                    </Td>
                    <Td className="align-top">
                      <ChevronRight size={13} className="text-zinc-600" />
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}

// ---------- level 3: one chat's messages ----------

const ROLE_TONES = { assistant: 'accent', user: 'neutral', system: 'info' };

function MessageBadges({ message }) {
  const attachments = message.attachments || [];
  if (!attachments.length && !message.isArtifactEdit && !message.error) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {attachments.map((att, index) => (
        <Badge
          // Attachments have no id of their own; index is stable because the list
          // is read-only and never reordered.
          key={`${att.name || 'file'}:${index}`}
          icon={att.kind === 'image' ? Eye : att.kind === 'pdf' ? FileText : Paperclip}
          title={[
            att.name || 'unnamed attachment',
            att.pageCount ? `${att.pageCount} page(s)` : null,
            att.scanned ? 'scanned (needed OCR / vision)' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {att.kind || 'file'}
        </Badge>
      ))}
      {message.isArtifactEdit && (
        <Badge tone="info" icon={Wand2} title="This reply was an edit of an artifact">
          artifact edit
        </Badge>
      )}
      {message.error && (
        <Badge tone="bad" title={message.error}>
          failed
        </Badge>
      )}
    </div>
  );
}

function MessageRows({ message }) {
  // Only worth naming the leg when there are two of them to tell apart.
  const legLabel = message.vision && message.chat ? 'reply model' : null;

  return (
    <>
      <tr className="align-top">
        <Td className="whitespace-nowrap align-top text-zinc-400">{fullDate(message.createdAt)}</Td>
        <Td className="whitespace-nowrap align-top font-mono text-[11px] text-zinc-400">
          {message.ip || <span className="text-zinc-600">—</span>}
        </Td>
        <Td className="align-top">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ROLE_TONES[message.role] || 'neutral'}>{message.role}</Badge>
            {message.vision && (
              <Badge
                tone="warn"
                title="This message billed two models: the reply model, plus a vision model that read its images. Both legs are listed."
              >
                2 billed calls
              </Badge>
            )}
          </div>
        </Td>
        <Td className="max-w-[26rem] align-top">
          {message.modelId ? (
            <span className="font-mono text-[11px] text-zinc-300">{message.modelId}</span>
          ) : (
            <Dash />
          )}
          {legLabel && <span className="ml-2 text-[11px] text-zinc-500">{legLabel}</span>}
          {message.preview && (
            <div
              className="mt-1 truncate text-[11px] leading-4 text-zinc-500"
              title={`${message.preview}${
                message.contentChars > message.preview.length
                  ? `\n\n(${num(message.contentChars)} characters in total)`
                  : ''
              }`}
            >
              {message.preview}
            </div>
          )}
          <MessageBadges message={message} />
        </Td>
        {message.chat ? (
          <>
            <TokenCells
              input={message.chat.inputTokens}
              output={message.chat.outputTokens}
              reasoning={message.chat.reasoningTokens}
            />
            <Td align="right" className="align-top tabular-nums font-medium text-zinc-100">
              {money(message.chat.costUsd)}
            </Td>
          </>
        ) : (
          // A user message carries no usage, and an assistant message can have a
          // vision leg without a reply leg. Dashes, so "no tokens" never reads as
          // "zero tokens".
          <>
            <Td align="right">
              <Dash />
            </Td>
            <Td align="right">
              <Dash />
            </Td>
            <Td align="right">
              <Dash />
            </Td>
            <Td align="right">
              <Dash />
            </Td>
          </>
        )}
      </tr>

      {message.vision && (
        <tr className="bg-white/[0.02] align-top">
          <Td />
          {/* Second spacer for the IP column: the vision call was made by the
              server as part of the same request, so it has no IP of its own. */}
          <Td />
          <Td className="align-top">
            <span className="ml-3 inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
              <CornerDownRight size={11} className="shrink-0" />
              same message
            </span>
          </Td>
          <Td className="align-top">
            <div className="ml-3 flex flex-wrap items-center gap-2">
              <Badge tone="info" icon={Eye}>
                vision call
              </Badge>
              <span className="font-mono text-[11px] text-zinc-300">
                {message.vision.modelId}
              </span>
            </div>
            <div className="ml-3 mt-1 text-[11px] leading-4 text-zinc-500">
              A second billed call on this message — the chat model can’t see images, so this model
              read them and is priced separately.
            </div>
          </Td>
          <TokenCells
            input={message.vision.inputTokens}
            output={message.vision.outputTokens}
            reasoning={message.vision.reasoningTokens}
          />
          <Td align="right" className="align-top tabular-nums text-zinc-300">
            {money(message.vision.costUsd)}
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {message.totalCostUsd === null
                ? 'message total unknown'
                : `${money(message.totalCostUsd)} message total`}
            </div>
          </Td>
        </tr>
      )}
    </>
  );
}

function MessagesLevel({ chatRes }) {
  const chat = chatRes.chat || {};
  const totals = chatRes.totals || {};
  const messages = chatRes.messages || [];

  return (
    <>
      <Card>
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-100">{chat.title || 'Untitled chat'}</h2>
            {chat.shared && (
              <Badge tone="info" icon={Share2} title="This chat has a public share link">
                shared
              </Badge>
            )}
            <Mono className="text-[11px]">{String(chat._id || '')}</Mono>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Owner">
              <span className="truncate">{chat.ownerEmail || describeOwnerKey(chat.ownerKey)}</span>
              <Mono className="text-[11px]">{chat.ownerKey}</Mono>
            </Detail>
            <Detail label="Chat model">
              <span className="font-mono text-[12px]">{chat.modelId || '—'}</span>
            </Detail>
            <Detail label="Vision model">
              {chat.visionModelId ? (
                <span className="font-mono text-[12px]">{chat.visionModelId}</span>
              ) : (
                <span className="text-xs text-zinc-500">none — the chat model reads its own images</span>
              )}
            </Detail>
            <Detail label="Created">{fullDate(chat.createdAt)}</Detail>
            <Detail label="Last message">{fullDate(chat.lastMessageAt)}</Detail>
            <Detail label="Parent chat">
              {chat.forkedFrom ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <GitFork size={12} className="shrink-0 text-zinc-500" />
                  <span className="truncate" title={chat.forkedFromTitle || undefined}>
                    fork of {chat.forkedFromTitle || <Mono className="text-[11px]">{String(chat.forkedFrom)}</Mono>}
                  </span>
                  {chat.forkedFromOwnerKey && chat.forkedFromOwnerKey !== chat.ownerKey && (
                    <Badge title={`The parent belongs to ${describeOwnerKey(chat.forkedFromOwnerKey)}`}>
                      someone else’s
                    </Badge>
                  )}
                </span>
              ) : (
                <Dash />
              )}
            </Detail>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CostTile totals={totals} />
        <StatTile
          label="Messages"
          value={num(totals.messages)}
          hint={`${num(totals.billedMessages)} billed`}
        />
        <TokenTiles totals={totals} />
        <StatTile label="Total tokens" value={num(totals.totalTokens)} hint="both legs" />
      </div>

      <Card
        title="Messages"
        description="Oldest first. Each billed call is its own row, so a message that used a vision model shows both legs."
      >
        <TableWrap>
          <table className="w-full min-w-[72rem] border-collapse">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>IP</Th>
                <Th>Role</Th>
                <Th>Model</Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                <Th align="right">Reasoning</Th>
                <Th align="right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {messages.length === 0 ? (
                <EmptyRow colSpan={8}>This chat has no messages.</EmptyRow>
              ) : (
                messages.map((message) => <MessageRows key={message._id} message={message} />)
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  );
}

// ---------- panel ----------

export default function UsagePanel() {
  const usage = useAdminStore((s) => s.usage);
  const usageOwner = useAdminStore((s) => s.usageOwner);
  const usageChat = useAdminStore((s) => s.usageChat);
  const usageWindow = useAdminStore((s) => s.usageWindow);
  const usageLoading = useAdminStore((s) => s.usageLoading);
  const loadUsage = useAdminStore((s) => s.loadUsage);
  const openUsageOwner = useAdminStore((s) => s.openUsageOwner);
  const openUsageChat = useAdminStore((s) => s.openUsageChat);
  const closeUsageOwner = useAdminStore((s) => s.closeUsageOwner);
  const closeUsageChat = useAdminStore((s) => s.closeUsageChat);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  // Every level reports its own pricedAt; the deepest one is what is on screen.
  const pricedAt = usageChat?.pricedAt || usageOwner?.pricedAt || usage?.pricedAt || null;
  const ownerKey = usageOwner?.ownerKey || usageChat?.chat?.ownerKey || null;
  // The chats response doesn't repeat the person's name, so it comes from the
  // people list when that is loaded.
  const owner = ownerKey ? (usage?.users || []).find((u) => u.ownerKey === ownerKey) || null : null;
  const ownerLabel = owner?.label || (ownerKey ? describeOwnerKey(ownerKey) : null);

  if (!usage && !usageOwner && !usageChat) {
    // The store toasts its own load errors and leaves the state null, so the
    // not-loading case here is a failure, not an empty report.
    if (usageLoading) return <Spinner label="Pricing every message…" />;
    return (
      <div className="space-y-4">
        <Callout tone="warn">The usage report could not be loaded.</Callout>
        <Button variant="primary" onClick={() => loadUsage()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Callout tone="info" icon={Info}>
        Costs are computed from each model’s <strong>current</strong> price
        {pricedAt ? ` (read ${fullDate(pricedAt)})` : ''} — messages don’t store the price that was
        in force when they were sent, so this is a cost report, not an invoice. Reasoning tokens are
        already part of the output tokens and are shown for information only; they are never billed
        twice. A message that needed a vision model bills two models, and both are counted.
      </Callout>

      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Crumb onClick={closeUsageOwner} current={!usageOwner && !usageChat}>
          All users
        </Crumb>
        {ownerLabel && (
          <>
            <ChevronRight size={12} className="shrink-0 text-zinc-600" />
            <Crumb
              current={!usageChat}
              onClick={() => (usageOwner ? closeUsageChat() : openUsageOwner(ownerKey))}
            >
              {ownerLabel}
            </Crumb>
          </>
        )}
        {usageChat && (
          <>
            <ChevronRight size={12} className="shrink-0 text-zinc-600" />
            <Crumb current>{usageChat.chat?.title || 'Untitled chat'}</Crumb>
          </>
        )}
        {usageLoading && (
          <span className="ml-2 inline-flex shrink-0 items-center gap-1.5 text-zinc-500">
            <Loader2 size={11} className="animate-spin" />
            loading
          </span>
        )}
      </div>

      <div className={clsx('space-y-5', usageLoading && 'opacity-60')}>
        {usageChat ? (
          <MessagesLevel chatRes={usageChat} />
        ) : usageOwner ? (
          <ChatsLevel
            owner={owner}
            ownerKey={usageOwner.ownerKey}
            chatsRes={usageOwner}
            windowed={Boolean(usageWindow.from || usageWindow.to)}
            onOpen={openUsageChat}
          />
        ) : (
          <PeopleLevel usage={usage} onOpen={openUsageOwner} />
        )}
      </div>
    </div>
  );
}
