import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  DatabaseZap,
  Info,
  RefreshCw,
  Save,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import { timeAgo } from '../lib/format.js';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmInline,
  Field,
  NumberInput,
  Select,
  Spinner,
  TextInput,
} from './ui.jsx';

/**
 * Settings for the pieces of the dashboard that aren't a company or a model:
 * which model reads pricing pages, how much of a page it is allowed to read,
 * and whether a fetched price needs a human before it is written.
 *
 * The draft/save pattern is deliberate — these three fields change how money is
 * spent and whether prices land unreviewed, so nothing here saves on keystroke.
 */

const MIN_FETCH_CHARS = 2_000;
const MAX_FETCH_CHARS = 400_000;

/** Only the fields the admin can actually change here. */
function draftFrom(settings) {
  return {
    adminModelId: settings?.adminModelId ?? '',
    fetchMaxChars: settings?.fetchMaxChars ?? 60_000,
    requireApproval: settings?.requireApproval !== false,
  };
}

/**
 * The dashboard's own URL. It is deliberately not `/admin` — a public host gets
 * scanned for that within minutes — and the segment is never in the JS bundle, so
 * this card is the one place it can be read and copied.
 */
function DashboardAddress() {
  const settings = useAdminStore((s) => s.settings);
  const saveSettings = useAdminStore((s) => s.saveSettings);
  const isBusy = useAdminStore((s) => s.isBusy);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const current = settings?.adminPath || '';
  const pinned = Boolean(settings?.adminPathPinned);
  const value = draft || current;
  const invalid = value !== current && !/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(value);
  const fullUrl = current ? `${window.location.origin}/${current}` : '';

  const move = async () => {
    if (invalid || value === current) return;
    const res = await saveSettings({ adminPath: value });
    if (res.ok) {
      // The page we are on no longer exists — follow the dashboard to its new home.
      window.location.assign(`/${value}`);
    }
  };

  return (
    <Card
      title="Dashboard address"
      description="This dashboard is not served from /admin. Bookmark the link below — it is the only way back in."
    >
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-white/[0.08] bg-surface-950/80 px-3 py-2 font-mono text-[13px] text-zinc-200">
            {fullUrl || '—'}
          </code>
          <Button
            icon={copied ? Check : Copy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(fullUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                /* clipboard blocked — the value is on screen to copy by hand */
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <Callout tone="info" icon={ShieldCheck}>
          Hiding the URL is a second line of defence, not the lock. Every request under
          it still checks that you are signed in as an administrator, and a wrong
          address returns a plain 404 — so a scanner finds no admin surface to probe at all.
        </Callout>

        {pinned ? (
          <Callout tone="info" icon={Info}>
            The address is pinned by <span className="font-mono text-[11px]">ADMIN_PATH</span> in
            server/.env. Change it there and restart the server.
          </Callout>
        ) : (
          <Field
            label="Change the address"
            hint="3–64 characters: letters, digits, dashes or underscores. Saving moves the dashboard immediately and takes you to the new URL — anyone with the old link loses access."
            error={invalid ? 'Letters, digits, dashes and underscores only (3–64 characters).' : null}
            className="max-w-md"
          >
            <div className="flex gap-2">
              <TextInput value={value} onChange={setDraft} mono placeholder="my-secret-console" />
              <Button
                variant="secondary"
                onClick={move}
                busy={isBusy('settings')}
                disabled={invalid || value === current}
              >
                Move
              </Button>
            </div>
          </Field>
        )}
      </div>
    </Card>
  );
}

export default function SettingsPanel() {
  const settings = useAdminStore((s) => s.settings);
  const candidates = useAdminStore((s) => s.adminModelCandidates);
  const saveSettings = useAdminStore((s) => s.saveSettings);
  const reloadRegistry = useAdminStore((s) => s.reloadRegistry);
  const reseedRegistry = useAdminStore((s) => s.reseedRegistry);
  const isBusy = useAdminStore((s) => s.isBusy);

  const [draft, setDraft] = useState(() => draftFrom(settings));

  // Re-sync when the store reloads (a save, or another tab's refresh).
  useEffect(() => {
    setDraft(draftFrom(settings));
  }, [settings]);

  const saved = useMemo(() => draftFrom(settings), [settings]);
  const changed = useMemo(
    () =>
      Object.keys(saved).filter((key) => draft[key] !== saved[key]),
    [draft, saved]
  );

  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const modelOptions = [
    { value: '', label: 'None — price fetching disabled' },
    ...candidates.map((m) => ({
      value: m.id,
      label: `${m.companyName} — ${m.name}`,
    })),
  ];

  // A model configured before its company lost its key stays selected but is no
  // longer in `candidates`; keep it visible so it can be seen and replaced.
  const missingCurrent =
    draft.adminModelId && !candidates.some((m) => m.id === draft.adminModelId);
  if (missingCurrent) {
    modelOptions.push({
      value: draft.adminModelId,
      label: `${draft.adminModelId} (unavailable)`,
    });
  }

  const charsInvalid =
    draft.fetchMaxChars == null ||
    draft.fetchMaxChars < MIN_FETCH_CHARS ||
    draft.fetchMaxChars > MAX_FETCH_CHARS;

  const onSave = async () => {
    if (charsInvalid || !changed.length) return;
    const patch = {};
    for (const key of changed) {
      patch[key] = key === 'adminModelId' ? draft.adminModelId || null : draft[key];
    }
    await saveSettings(patch);
  };

  if (!settings) return <Spinner label="Loading settings…" />;

  return (
    <div className="space-y-5">
      <Card
        title="Admin LLM"
        description="The model that reads pricing pages and extracts prices from them. It never takes part in a user's conversation."
      >
        <div className="space-y-4 px-5 py-4">
          {candidates.length === 0 && (
            <Callout tone="warn">
              No company has a usable API key, so there is no model that can read a pricing page. Add
              a key on the <span className="font-medium">Companies</span> tab first — until then,
              prices have to be typed in by hand on the Models tab.
            </Callout>
          )}

          <Field
            label="Model used for price extraction"
            hint="A cheap, reliable, long-context model is the right choice — it reads a few pages of text and returns JSON. Demo models are excluded: they cannot read a web page."
          >
            <Select
              value={draft.adminModelId}
              onChange={(value) => set('adminModelId', value)}
              options={modelOptions}
            />
          </Field>

          {missingCurrent && (
            <Callout tone="warn">
              The configured model{' '}
              <span className="font-mono text-[11px]">{draft.adminModelId}</span> is no longer
              available — its company may have been deactivated or lost its key. Price fetches will
              fail until you pick another one.
            </Callout>
          )}

          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Bot size={13} className="shrink-0" />
            <span>
              A fetch can also override this per run, and{' '}
              <span className="font-mono text-[11px]">ADMIN_LLM_MODEL</span> in server/.env acts as
              the fallback when nothing is set here.
            </span>
          </div>
        </div>
      </Card>

      <Card
        title="Price fetching"
        description="How much of a pricing page is sent to the admin model, and whether what comes back needs approval."
      >
        <div className="space-y-4 px-5 py-4">
          <Field
            label="Maximum page characters"
            hint={`A pricing page is mostly navigation chrome; this caps what is handed to the admin model, which is what caps the cost of a fetch. Between ${MIN_FETCH_CHARS.toLocaleString()} and ${MAX_FETCH_CHARS.toLocaleString()}.`}
            error={
              charsInvalid
                ? `Enter a value between ${MIN_FETCH_CHARS.toLocaleString()} and ${MAX_FETCH_CHARS.toLocaleString()}.`
                : null
            }
            className="max-w-xs"
          >
            <NumberInput
              value={draft.fetchMaxChars}
              onChange={(value) => set('fetchMaxChars', value)}
              step={1000}
              min={MIN_FETCH_CHARS}
            />
          </Field>

          <div className="space-y-2">
            <Checkbox
              checked={draft.requireApproval}
              onChange={(value) => set('requireApproval', value)}
              label="Review fetched prices before they are applied (recommended)"
            />
            {draft.requireApproval ? (
              <p className="pl-6 text-[11px] leading-5 text-zinc-500">
                Every fetch lands as a proposal on the Pricing tab with a side-by-side diff. Nothing
                is written until you apply it.
              </p>
            ) : (
              <div className="pl-6">
                <Callout tone="warn">
                  Auto-apply is on. Any row the extractor is confident about will be written to the
                  registry immediately, with no human check. A misread page then changes the cost
                  every user sees — the previous price is kept in the model’s price history, but
                  nobody is told it moved.
                </Callout>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
            <Button
              variant="primary"
              icon={Save}
              onClick={onSave}
              busy={isBusy('settings')}
              disabled={!changed.length || charsInvalid}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDraft(draftFrom(settings))}
              disabled={!changed.length}
            >
              Reset
            </Button>
            {changed.length > 0 && (
              <Badge tone="warn">
                {changed.length} unsaved change{changed.length === 1 ? '' : 's'}
              </Badge>
            )}
            {settings.updatedAt && !changed.length && (
              <span className="text-[11px] text-zinc-500">Saved {timeAgo(settings.updatedAt)}</span>
            )}
          </div>
        </div>
      </Card>

      <DashboardAddress />

      <Card
        title="Maintenance"
        description="Housekeeping for the registry cache and the built-in defaults."
      >
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-start gap-3">
            <Button
              icon={RefreshCw}
              onClick={() => reloadRegistry()}
              busy={isBusy('registry:reload')}
            >
              Reload registry
            </Button>
            <p className="min-w-[16rem] flex-1 text-[11px] leading-5 text-zinc-500">
              Re-reads companies and models from MongoDB into the running server. Every change made
              here already does this — use it after editing the database directly.
            </p>
          </div>

          <div className="flex flex-wrap items-start gap-3 border-t border-white/[0.06] pt-4">
            <ConfirmInline
              onConfirm={() => reseedRegistry()}
              label="Restore defaults"
              busy={isBusy('registry:reseed')}
            >
              <Button icon={DatabaseZap} variant="secondary">
                Restore built-in defaults
              </Button>
            </ConfirmInline>
            <p className="min-w-[16rem] flex-1 text-[11px] leading-5 text-zinc-500">
              Re-inserts any built-in company or model that has been deleted. It never overwrites a
              row that still exists, so your edits and prices are safe.
            </p>
          </div>

          <Callout tone="info" icon={Info}>
            The built-in defaults live in{' '}
            <span className="font-mono text-[11px]">server/src/config/seedRegistry.js</span>. They
            seed an empty database on first boot and are only a starting point — MongoDB is the
            source of truth from then on.
          </Callout>
        </div>
      </Card>

      <Card title="Where the rest lives" className="border-white/[0.05]">
        <div className="space-y-2 px-5 py-4 text-[11px] leading-5 text-zinc-500">
          <p className="flex gap-2">
            <Wrench size={13} className="mt-0.5 shrink-0" />
            <span>
              Admin access is granted by{' '}
              <span className="font-mono">ADMIN_EMAILS</span> in server/.env (promoted on sign-in),
              or with <span className="font-mono">npm --prefix server run make-admin -- &lt;email&gt;</span>.
            </span>
          </p>
          <p className="flex gap-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              Stored API keys are encrypted with{' '}
              <span className="font-mono">ENCRYPTION_KEY</span>. If that is unset the key is derived
              from <span className="font-mono">JWT_SECRET</span>, and rotating JWT_SECRET makes
              every stored provider key unreadable — see the Overview tab for which one is in use.
            </span>
          </p>
        </div>
      </Card>
    </div>
  );
}
