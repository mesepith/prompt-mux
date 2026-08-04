import { useState } from 'react';
import { CircleAlert, CircleCheck, Eye, EyeOff, KeyRound, Radar, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import { formatPrice, fullDate, timeAgo } from '../lib/format.js';
import {
  Badge,
  Button,
  Callout,
  ConfirmInline,
  Field,
  IconButton,
  Modal,
  Mono,
  TextInput,
} from './ui.jsx';

/**
 * One company's API key: set it, remove it, test it, and ask the provider which
 * models it actually serves. The key only ever travels one way — the API returns
 * the last four digits and nothing else, so there is no "reveal" here by design.
 */

function IdList({ ids, empty }) {
  if (!ids?.length) return <p className="text-xs text-zinc-500">{empty}</p>;
  return (
    <div className="max-h-40 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/20 p-2">
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <Mono key={id}>{id}</Mono>
        ))}
      </div>
    </div>
  );
}

export default function KeyPanel() {
  const slug = useAdminStore((s) => s.keyPanelSlug);
  // Calling the store's lookup inside the selector keeps this panel subscribed
  // to the provider object itself, so a save/test refresh re-renders it.
  const provider = useAdminStore((s) => s.providerBySlug(slug));
  const busyMap = useAdminStore((s) => s.busy);
  const closeKeyPanel = useAdminStore((s) => s.closeKeyPanel);
  const setProviderKey = useAdminStore((s) => s.setProviderKey);
  const clearProviderKey = useAdminStore((s) => s.clearProviderKey);
  const testProviderKey = useAdminStore((s) => s.testProviderKey);
  const discoverModels = useAdminStore((s) => s.discoverModels);

  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [inputError, setInputError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [discovery, setDiscovery] = useState(null);

  if (!provider) return null;

  const { envKey, keySource, apiKeyLast4, requiresKey } = provider;
  const savingKey = Boolean(busyMap[`provider:${slug}:key`]);
  const testing = Boolean(busyMap[`provider:${slug}:test`]);
  const discovering = Boolean(busyMap[`provider:${slug}:discover`]);
  const envFallback = envKey ? `the ${envKey} environment variable` : 'the server environment';

  const save = async () => {
    const key = value.trim();
    if (!key) {
      setInputError('Paste a key first');
      return;
    }
    setInputError(null);
    const res = await setProviderKey(slug, key);
    if (res.ok) {
      setValue('');
      setRevealed(false);
      setTestResult(null);
    }
  };

  const test = async () => {
    const res = await testProviderKey(slug);
    setTestResult(
      res.ok
        ? res.result
        : { ok: false, message: res.error || 'The test request failed' }
    );
  };

  // The response carries what the call cost, so report it rather than leaving the
  // admin to go and look it up on the Overview tab.
  const testCostLine = (result) => {
    if (!result?.usage) return null;
    const { inputTokens = 0, outputTokens = 0 } = result.usage;
    const cost = result.costUsd == null ? null : formatPrice(result.costUsd);
    return `${inputTokens} in + ${outputTokens} out tokens${cost ? ` · ${cost}` : ''}`;
  };

  const discover = async () => {
    const res = await discoverModels(slug);
    if (res.ok) setDiscovery(res.result);
  };

  return (
    <Modal
      title={`API key — ${provider.name}`}
      description="Applies to every model of this company, for every user, as soon as it is saved."
      onClose={closeKeyPanel}
      footer={
        <Button variant="ghost" onClick={closeKeyPanel}>
          Close
        </Button>
      }
    >
      <div className="space-y-5">
        <Callout tone="info" icon={ShieldCheck}>
          The key is encrypted with AES-256-GCM before it is written to the database and is never
          sent back to the browser — only its last four digits are. A key stored here takes
          precedence over {envFallback}.
        </Callout>

        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {keySource === 'db' && (
              <>
                <Badge tone="good" icon={KeyRound}>
                  Stored in the database
                </Badge>
                <Mono>••••{apiKeyLast4 || '????'}</Mono>
                <span className="text-xs text-zinc-500" title={fullDate(provider.apiKeyUpdatedAt)}>
                  updated {timeAgo(provider.apiKeyUpdatedAt)}
                </span>
              </>
            )}
            {keySource === 'env' && <Badge tone="info">Coming from {envKey}</Badge>}
            {keySource === 'none' &&
              (requiresKey === false ? (
                <Badge>No key needed for this adapter</Badge>
              ) : (
                <Badge tone="bad">No key — this company’s models are unusable</Badge>
              ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {provider.keyStatus === 'ok' && (
              <>
                <Badge tone="good" icon={CircleCheck}>
                  Last test passed
                </Badge>
                <span title={fullDate(provider.keyCheckedAt)}>{timeAgo(provider.keyCheckedAt)}</span>
              </>
            )}
            {provider.keyStatus === 'failed' && (
              <>
                <Badge tone="bad">Last test failed</Badge>
                <span className="text-rose-300/80">{provider.keyStatusMessage}</span>
              </>
            )}
            {provider.keyStatus === 'unknown' && <span>Never tested.</span>}
          </div>
        </div>

        <div>
          <Field
            label={keySource === 'db' ? 'Replace the key' : 'New key'}
            error={inputError}
            hint="Pasted keys are trimmed. Saving replaces whatever is stored now."
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  type={revealed ? 'text' : 'password'}
                  value={value}
                  onChange={(next) => {
                    setValue(next);
                    setInputError(null);
                  }}
                  placeholder="sk-…"
                  mono
                  disabled={savingKey}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save();
                  }}
                />
              </div>
              <IconButton
                icon={revealed ? EyeOff : Eye}
                title={revealed ? 'Hide the key' : 'Show what you typed'}
                onClick={() => setRevealed((r) => !r)}
              />
              <Button variant="primary" size="sm" busy={savingKey} onClick={save}>
                Save key
              </Button>
            </div>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          <Button icon={Zap} size="sm" busy={testing} onClick={test}>
            Test key
          </Button>
          <Button icon={Radar} size="sm" busy={discovering} onClick={discover}>
            Discover models
          </Button>
          {/* Be straight about which of these two spends money. There is no
              vendor-neutral way to validate a key without calling the API. */}
          <span className="text-[11px] text-zinc-500">
            Test makes one real call (~25 tokens, a fraction of a cent, logged under Admin
            operations). Discover models is free.
          </span>
          {keySource === 'db' && (
            <ConfirmInline label="Remove key" busy={savingKey} onConfirm={() => clearProviderKey(slug)}>
              <Button icon={Trash2} size="sm" variant="danger">
                Remove stored key
              </Button>
            </ConfirmInline>
          )}
        </div>

        {keySource === 'db' && (
          <p className="text-[11px] leading-5 text-zinc-500">
            Removing the stored key falls back to {envFallback} if it is set; otherwise this
            company’s models stop working immediately.
          </p>
        )}

        {testResult && (
          <Callout tone={testResult.ok ? 'info' : 'bad'} icon={testResult.ok ? CircleCheck : CircleAlert}>
            {testResult.message || (testResult.ok ? 'The provider answered.' : 'The provider refused the key.')}
            {testResult.modelId && (
              <>
                {' '}
                Tested with <Mono>{testResult.modelId}</Mono>.
              </>
            )}
            {testCostLine(testResult) && (
              <div className="mt-1 text-[11px] text-zinc-400">
                This call cost {testCostLine(testResult)}.
              </div>
            )}
          </Callout>
        )}

        {discovery && (
          <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <Badge tone="info">{discovery.ids?.length || 0} served by the provider</Badge>
              <Badge>{discovery.known?.length || 0} in the registry</Badge>
              <span>This is a report only — nothing was created, changed or removed.</span>
            </div>

            <div>
              <h3 className="mb-1.5 text-xs font-semibold text-zinc-300">
                Not in the registry ({discovery.newFromProvider?.length || 0})
              </h3>
              <IdList
                ids={discovery.newFromProvider}
                empty="Nothing new — the registry already covers everything this key can reach."
              />
              {Boolean(discovery.newFromProvider?.length) && (
                <p className="mt-1.5 text-[11px] text-zinc-500">
                  Add the ones you want on the Models tab; the id above goes in the “API model” field.
                </p>
              )}
            </div>

            <div>
              <h3 className="mb-1.5 text-xs font-semibold text-zinc-300">
                In the registry but no longer served ({discovery.missingFromProvider?.length || 0})
              </h3>
              {discovery.missingFromProvider?.length ? (
                <>
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/20 p-2">
                    {discovery.missingFromProvider.map((m) => (
                      <div key={m.slug} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-zinc-300">{m.name}</span>
                        <Mono>{m.apiModel}</Mono>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-amber-300/80">
                    Probably retired by the provider — calls to these will fail. Deactivate them
                    rather than deleting, so old conversations keep their model names.
                  </p>
                </>
              ) : (
                <p className="text-xs text-zinc-500">
                  Every registry model of this company is still served.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
