import { ExternalLink, KeyRound, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useAdminStore } from '../useAdminStore.js';
import { navigateToAdmin } from '../../lib/router.js';
import { fullDate, timeAgo } from '../lib/format.js';
import {
  Badge,
  Button,
  Card,
  ConfirmInline,
  EmptyRow,
  IconButton,
  Mono,
  TableWrap,
  Td,
  Th,
  Toggle,
} from './ui.jsx';

/**
 * The LLM companies table. A company is the unit that owns an adapter, a base
 * URL and an API key; its models inherit availability from it, which is why the
 * Active toggle here is the biggest switch in the dashboard.
 */

/** Pricing pages have long URLs — the host is enough to recognise one. */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function KeyCell({ provider, testing, onOpenKey, onTest }) {
  const { keySource, apiKeyLast4, envKey, requiresKey, keyStatus, keyStatusMessage } = provider;
  const optional = requiresKey === false;
  const noKey = keySource === 'none';

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {keySource === 'db' && (
        <Badge tone="good" icon={KeyRound} title={`Saved ${fullDate(provider.apiKeyUpdatedAt)}`}>
          Stored ••••{apiKeyLast4 || '????'}
        </Badge>
      )}
      {keySource === 'env' && (
        <Badge tone="info" title="Read from the server environment — no key stored in the database">
          From {envKey}
        </Badge>
      )}
      {noKey && (optional ? <Badge>Not needed</Badge> : <Badge tone="bad">No key</Badge>)}

      {keyStatus === 'ok' && <Badge tone="good">verified {timeAgo(provider.keyCheckedAt)}</Badge>}
      {keyStatus === 'failed' && (
        <Badge tone="bad" title={keyStatusMessage || 'The last test call failed'}>
          test failed
        </Badge>
      )}

      <Button size="sm" variant="ghost" onClick={onOpenKey} title="Set, replace or remove the key">
        Key
      </Button>
      <Button
        size="sm"
        variant="ghost"
        busy={testing}
        // A company that needs a key and has none can only fail the test; one
        // that needs no key (the offline demo adapter) is worth testing.
        disabled={noKey && !optional}
        title={noKey && !optional ? 'Add a key first' : 'Send one tiny request to the provider'}
        onClick={onTest}
      >
        Test
      </Button>
    </div>
  );
}

export default function ProvidersPanel() {
  const providers = useAdminStore((s) => s.providers);
  // The `isBusy` helper is a stable reference, so subscribing to it alone would
  // never re-render — the `busy` map is what changes when an action starts.
  const busyMap = useAdminStore((s) => s.busy);
  const openProviderEditor = useAdminStore((s) => s.openProviderEditor);
  const openKeyPanel = useAdminStore((s) => s.openKeyPanel);
  const openPriceFetch = useAdminStore((s) => s.openPriceFetch);
  const toggleProvider = useAdminStore((s) => s.toggleProvider);
  const deleteProvider = useAdminStore((s) => s.deleteProvider);
  const testProviderKey = useAdminStore((s) => s.testProviderKey);
  const setModelCompany = useAdminStore((s) => s.setModelCompany);

  const isBusy = (key) => Boolean(busyMap[key]);

  const showModels = (slug) => {
    setModelCompany(slug);
    navigateToAdmin('models');
  };

  return (
    <Card
      title="LLM companies"
      description="Deactivating a company hides it and every one of its models from all users’ model pickers straight away — no restart needed. Its conversations keep their history."
      actions={
        <Button variant="primary" icon={Plus} onClick={() => openProviderEditor(null)}>
          Add company
        </Button>
      }
    >
      <TableWrap>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th className="w-16">Active</Th>
              <Th>Company</Th>
              <Th>API key</Th>
              <Th align="right">Models</Th>
              <Th>Base URL</Th>
              <Th>Pricing</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => {
              const { slug, active } = provider;
              return (
                <tr
                  key={slug}
                  className={clsx('transition-opacity hover:bg-white/[0.02]', !active && 'opacity-50')}
                >
                  <Td>
                    <Toggle
                      checked={active}
                      busy={isBusy(`provider:${slug}:active`)}
                      label={active ? `Deactivate ${provider.name}` : `Activate ${provider.name}`}
                      onChange={(next) => toggleProvider(slug, next)}
                    />
                  </Td>

                  <Td>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: provider.color || '#71717a' }}
                      />
                      <span className="font-medium text-zinc-100">{provider.name}</span>
                      <Mono>{slug}</Mono>
                      <Badge tone="accent" title="Which provider adapter serves this company">
                        {provider.adapter}
                      </Badge>
                    </div>
                  </Td>

                  <Td>
                    <KeyCell
                      provider={provider}
                      testing={isBusy(`provider:${slug}:test`)}
                      onOpenKey={() => openKeyPanel(slug)}
                      onTest={() => testProviderKey(slug)}
                    />
                  </Td>

                  <Td align="right">
                    <button
                      type="button"
                      onClick={() => showModels(slug)}
                      title={`Show ${provider.name}’s models`}
                      className="rounded-md px-1.5 py-0.5 tabular-nums text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100"
                    >
                      {provider.activeModelCount}
                      <span className="text-zinc-600"> / {provider.modelCount}</span>
                    </button>
                  </Td>

                  <Td>
                    {provider.baseURL ? (
                      <Mono className="break-all">{provider.baseURL}</Mono>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                    {provider.baseUrlEnv && (
                      <div className="mt-1 text-[11px] text-zinc-500">
                        overridden by {provider.baseUrlEnv} when that variable is set
                      </div>
                    )}
                  </Td>

                  <Td>
                    <div className="flex items-center gap-2">
                      {provider.pricingUrl ? (
                        <a
                          href={provider.pricingUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={provider.pricingUrl}
                          className="inline-flex max-w-[10rem] items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                        >
                          <ExternalLink size={11} className="shrink-0" />
                          <span className="truncate">{hostOf(provider.pricingUrl)}</span>
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-600">not set</span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Tags}
                        busy={isBusy(`price:${slug}`)}
                        onClick={() => openPriceFetch({ providerSlug: slug })}
                      >
                        Fetch prices
                      </Button>
                    </div>
                  </Td>

                  <Td align="right">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        icon={Pencil}
                        title={`Edit ${provider.name}`}
                        onClick={() => openProviderEditor(provider)}
                      />
                      <ConfirmInline
                        label="Delete"
                        busy={isBusy(`provider:${slug}:delete`)}
                        onConfirm={() => deleteProvider(slug)}
                      >
                        <IconButton icon={Trash2} tone="danger" title={`Delete ${provider.name}`} />
                      </ConfirmInline>
                    </div>
                  </Td>
                </tr>
              );
            })}

            {!providers.length && (
              <EmptyRow colSpan={7}>
                No companies yet. Add one, or restore the built-in defaults from the Settings tab.
              </EmptyRow>
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
