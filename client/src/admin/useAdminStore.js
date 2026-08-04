import { create } from 'zustand';
import { adminApi } from '../api/client.js';

/**
 * State for the admin dashboard, kept separate from the chat store on purpose:
 * the two share nothing but the logged-in user, and the dashboard is only ever
 * mounted on /admin. Panels read and write this store directly — same
 * convention as the chat side, no prop-drilling.
 *
 * Every mutating action goes through `run()`, which owns the busy flag, error
 * capture and the success toast, and returns `{ ok, ...payload }` so a form can
 * decide whether to close itself. Actions that change the registry refresh both
 * providers and models, because a provider toggle changes which models are
 * effectively usable.
 */

const IDLE = { loading: false, error: null };

export const useAdminStore = create((set, get) => ({
  ...IDLE,
  // Loaded once when the dashboard mounts.
  booted: false,
  accessDenied: false, // 403 from the API — shown as a "no access" screen
  overview: null,
  providers: [],
  models: [],
  settings: null,
  adminModelCandidates: [],
  proposals: [],
  activeProposal: null,
  auditEntries: [],

  // ui
  busy: {}, // action key -> true, so one row's spinner doesn't freeze the table
  toast: null, // { kind: 'success' | 'error', message }
  modelQuery: '',
  modelCompany: 'all',
  showInactive: true,
  editingProvider: null, // provider object, {} for "new", or null when closed
  editingModel: null, // model object, { company } for "new", or null when closed
  keyPanelSlug: null, // provider slug whose key editor is open
  priceFetchTarget: null, // { providerSlug, modelSlug?, url }
  fetchPlan: null, // pages a company-level fetch would read + cost estimate
  fetchPlanLoading: false,
  // Usage reporting drill-down: people -> their chats -> one chat's messages.
  // Each level is fetched on demand; `usageLevel` is what the panel renders.
  usage: null, // GET /usage/users response
  usageOwner: null, // GET /usage/users/:ownerKey/chats response
  usageChat: null, // GET /usage/chats/:id response
  usageWindow: { from: '', to: '' },
  usageLoading: false,

  // ---------- helpers ----------
  isBusy: (key) => Boolean(get().busy[key]),
  providerBySlug: (slug) => get().providers.find((p) => p.slug === slug) || null,
  modelBySlug: (slug) => get().models.find((m) => m.slug === slug) || null,

  visibleModels: () => {
    const { models, modelQuery, modelCompany, showInactive } = get();
    const q = modelQuery.trim().toLowerCase();
    return models.filter((m) => {
      if (!showInactive && !m.active) return false;
      if (modelCompany !== 'all' && m.company !== modelCompany) return false;
      if (!q) return true;
      return [m.slug, m.name, m.apiModel, m.companyName, m.tagline]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  },

  showToast: (kind, message) => {
    set({ toast: { kind, message, at: Date.now() } });
    return { ok: kind === 'success' };
  },
  dismissToast: () => set({ toast: null }),

  setBusy: (key, value) =>
    set((s) => {
      const busy = { ...s.busy };
      if (value) busy[key] = true;
      else delete busy[key];
      return { busy };
    }),

  /**
   * Runs one API action with a busy flag and uniform error handling.
   * `success` is a message (or a function of the result) for the toast; omit it
   * to stay silent. Returns { ok: true, result } or { ok: false, error }.
   */
  run: async (key, fn, { success, refresh } = {}) => {
    get().setBusy(key, true);
    set({ error: null });
    try {
      const result = await fn();
      if (success) {
        const message = typeof success === 'function' ? success(result) : success;
        if (message) get().showToast('success', message);
      }
      if (refresh) await get()[refresh]();
      return { ok: true, result };
    } catch (err) {
      if (err.code === 'ADMIN_REQUIRED' || err.code === 'AUTH_REQUIRED') {
        set({ accessDenied: true });
      }
      set({ error: err.message });
      get().showToast('error', err.message);
      return { ok: false, error: err.message };
    } finally {
      get().setBusy(key, false);
    }
  },

  // ---------- loading ----------
  boot: async () => {
    set({ loading: true, error: null, accessDenied: false });
    try {
      const [overview, providersRes, modelsRes, settingsRes] = await Promise.all([
        adminApi.overview(),
        adminApi.listProviders(),
        adminApi.listModels({ includeInactive: 1 }),
        adminApi.getSettings(),
      ]);
      set({
        overview,
        providers: providersRes.providers,
        models: modelsRes.models,
        settings: settingsRes.settings,
        adminModelCandidates: settingsRes.candidates || [],
        booted: true,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        booted: true,
        error: err.message,
        accessDenied: err.code === 'ADMIN_REQUIRED' || err.code === 'AUTH_REQUIRED',
      });
    }
  },

  refreshOverview: async () => {
    const overview = await adminApi.overview();
    set({ overview });
  },

  refreshProviders: async () => {
    const [providersRes, overview] = await Promise.all([
      adminApi.listProviders(),
      adminApi.overview(),
    ]);
    set({ providers: providersRes.providers, overview });
  },

  refreshModels: async () => {
    const [modelsRes, overview] = await Promise.all([
      adminApi.listModels({ includeInactive: 1 }),
      adminApi.overview(),
    ]);
    set({ models: modelsRes.models, overview });
  },

  // A provider change (active, key, deletion) also changes what its models can
  // do, so both tables are refetched together.
  refreshRegistry: async () => {
    const [providersRes, modelsRes, overview] = await Promise.all([
      adminApi.listProviders(),
      adminApi.listModels({ includeInactive: 1 }),
      adminApi.overview(),
    ]);
    set({
      providers: providersRes.providers,
      models: modelsRes.models,
      overview,
    });
  },

  refreshProposals: async (providerSlug) => {
    const res = await adminApi.listProposals({ providerSlug, limit: 25 });
    set({ proposals: res.proposals });
  },

  // ---------- usage reporting ----------
  setUsageWindow: (usageWindow) => set({ usageWindow }),

  loadUsage: async () => {
    const { from, to } = get().usageWindow;
    set({ usageLoading: true });
    try {
      const usage = await adminApi.usageUsers({ from, to });
      set({ usage, usageLoading: false });
      return usage;
    } catch (err) {
      set({ usageLoading: false });
      get().showToast('error', err.message);
      return null;
    }
  },

  openUsageOwner: async (ownerKey) => {
    const { from, to } = get().usageWindow;
    set({ usageLoading: true, usageChat: null });
    try {
      const usageOwner = await adminApi.usageUserChats(ownerKey, { from, to });
      set({ usageOwner, usageLoading: false });
      return usageOwner;
    } catch (err) {
      set({ usageLoading: false });
      get().showToast('error', err.message);
      return null;
    }
  },

  openUsageChat: async (id) => {
    set({ usageLoading: true });
    try {
      const usageChat = await adminApi.usageChat(id);
      set({ usageChat, usageLoading: false });
      return usageChat;
    } catch (err) {
      set({ usageLoading: false });
      get().showToast('error', err.message);
      return null;
    }
  },

  // Breadcrumb navigation: closing a level returns to the one above it.
  closeUsageChat: () => set({ usageChat: null }),
  closeUsageOwner: () => set({ usageOwner: null, usageChat: null }),

  refreshAudit: async () => {
    const res = await adminApi.audit({ limit: 100 });
    set({ auditEntries: res.entries });
  },

  refreshSettings: async () => {
    const res = await adminApi.getSettings();
    set({ settings: res.settings, adminModelCandidates: res.candidates || [] });
  },

  // ---------- filters / dialogs ----------
  setModelQuery: (modelQuery) => set({ modelQuery }),
  setModelCompany: (modelCompany) => set({ modelCompany }),
  setShowInactive: (showInactive) => set({ showInactive }),
  openProviderEditor: (provider) => set({ editingProvider: provider || { isNew: true } }),
  closeProviderEditor: () => set({ editingProvider: null }),
  openModelEditor: (model) => set({ editingModel: model || { isNew: true } }),
  closeModelEditor: () => set({ editingModel: null }),
  openKeyPanel: (slug) => set({ keyPanelSlug: slug }),
  closeKeyPanel: () => set({ keyPanelSlug: null }),
  openPriceFetch: (target) => set({ priceFetchTarget: target, fetchPlan: null }),
  closePriceFetch: () => set({ priceFetchTarget: null, fetchPlan: null }),

  /**
   * Loads what a company-level fetch would read. Free — no model is called — so
   * the dialog can state the number of pages and the cost before anything is spent.
   */
  loadFetchPlan: async (providerSlug) => {
    set({ fetchPlanLoading: true });
    try {
      const plan = await adminApi.pricePlan(providerSlug);
      set({ fetchPlan: plan, fetchPlanLoading: false });
      return plan;
    } catch (err) {
      set({ fetchPlan: null, fetchPlanLoading: false });
      get().showToast('error', err.message);
      return null;
    }
  },

  // ---------- providers ----------
  createProvider: (body) =>
    get().run(`provider:create`, () => adminApi.createProvider(body), {
      success: (r) => `Added ${r.provider.name}`,
      refresh: 'refreshRegistry',
    }),

  updateProvider: (slug, patch) =>
    get().run(`provider:${slug}`, () => adminApi.updateProvider(slug, patch), {
      success: 'Company updated',
      refresh: 'refreshRegistry',
    }),

  toggleProvider: (slug, active) =>
    get().run(`provider:${slug}:active`, () => adminApi.updateProvider(slug, { active }), {
      success: active ? 'Company activated' : 'Company deactivated',
      refresh: 'refreshRegistry',
    }),

  deleteProvider: (slug) =>
    get().run(`provider:${slug}:delete`, () => adminApi.deleteProvider(slug), {
      success: 'Company removed',
      refresh: 'refreshRegistry',
    }),

  setProviderKey: (slug, apiKey) =>
    get().run(`provider:${slug}:key`, () => adminApi.setProviderKey(slug, apiKey), {
      success: 'API key saved',
      refresh: 'refreshRegistry',
    }),

  clearProviderKey: (slug) =>
    get().run(`provider:${slug}:key`, () => adminApi.clearProviderKey(slug), {
      success: 'Stored key removed',
      refresh: 'refreshRegistry',
    }),

  testProviderKey: (slug) =>
    get().run(`provider:${slug}:test`, () => adminApi.testProviderKey(slug), {
      success: (r) => (r.ok ? `Key works (${r.modelId})` : null),
      refresh: 'refreshProviders',
    }),

  discoverModels: (slug) =>
    get().run(`provider:${slug}:discover`, () => adminApi.discoverModels(slug), {
      refresh: 'refreshModels',
    }),

  // ---------- models ----------
  createModel: (body) =>
    get().run('model:create', () => adminApi.createModel(body), {
      success: (r) => `Added ${r.model.name}`,
      refresh: 'refreshModels',
    }),

  updateModel: (slug, patch) =>
    get().run(`model:${slug}`, () => adminApi.updateModel(slug, patch), {
      success: 'Model updated',
      refresh: 'refreshModels',
    }),

  toggleModel: (slug, active) =>
    get().run(`model:${slug}:active`, () => adminApi.updateModel(slug, { active }), {
      success: active ? 'Model activated' : 'Model deactivated',
      refresh: 'refreshModels',
    }),

  deleteModel: (slug, { force = false } = {}) =>
    get().run(`model:${slug}:delete`, () => adminApi.deleteModel(slug, { force }), {
      success: 'Model removed',
      refresh: 'refreshModels',
    }),

  bulkSetModelActive: (slugs, active) =>
    get().run('model:bulk', () => adminApi.bulkSetModelActive(slugs, active), {
      success: (r) => `${r.updated} model(s) ${active ? 'activated' : 'deactivated'}`,
      refresh: 'refreshModels',
    }),

  // ---------- pricing ----------
  /**
   * Reads a pricing page with the admin LLM and stores the result as a proposal.
   * Nothing is written to the registry here — `applyProposal` does that, after a
   * human has looked at the diff.
   */
  fetchPrices: async ({ providerSlug, modelSlug, url, adminModelId }) => {
    const key = `price:${modelSlug || providerSlug}`;
    const res = await get().run(key, () =>
      adminApi.fetchPrices({ providerSlug, modelSlug, url, adminModelId })
    );
    if (res.ok) {
      const { proposal } = res.result;
      set({ activeProposal: proposal });
      await get().refreshProposals();
      if (proposal.status === 'failed') {
        get().showToast('error', proposal.error || 'The price extraction failed');
      } else {
        const n = proposal.items?.length || 0;
        get().showToast(
          'success',
          n ? `Found ${n} price row(s) — review and apply` : 'No prices found on that page'
        );
      }
    }
    return res;
  },

  /**
   * Runs a multi-page fetch for a whole company. One proposal comes back per page;
   * the first is opened for review and the rest wait on the Pricing tab.
   */
  fetchPricesBatch: async ({ providerSlug, adminModelId, urls }) => {
    const key = `price:${providerSlug}`;
    const res = await get().run(key, () =>
      adminApi.fetchPricesBatch({ providerSlug, adminModelId, urls })
    );
    if (!res.ok) return res;
    const { proposals = [], calls, failed, itemCount, totalCostUsd } = res.result;
    const first = proposals.find((p) => p.status !== 'failed') || proposals[0] || null;
    set({ activeProposal: first });
    await get().refreshProposals();
    const cost = typeof totalCostUsd === 'number' ? ` · $${totalCostUsd.toFixed(4)}` : '';
    if (failed && failed === calls) {
      get().showToast('error', `All ${calls} page(s) failed — open one to see why.`);
    } else if (failed) {
      get().showToast(
        'error',
        `${calls - failed} of ${calls} pages read, ${itemCount} row(s) found${cost}. ${failed} failed.`
      );
    } else {
      get().showToast(
        'success',
        `Read ${calls} page(s), found ${itemCount} price row(s)${cost} — review and apply`
      );
    }
    return res;
  },

  openProposal: async (id) => {
    const res = await get().run(`proposal:${id}`, () => adminApi.getProposal(id));
    if (res.ok) set({ activeProposal: res.result.proposal });
    return res;
  },

  closeProposal: () => set({ activeProposal: null }),

  applyProposal: async (id, itemIds) => {
    const res = await get().run(`proposal:${id}:apply`, () => adminApi.applyProposal(id, itemIds), {
      success: (r) => `Updated ${r.applied} model price(s)`,
    });
    if (res.ok) {
      set({ activeProposal: res.result.proposal });
      await get().refreshModels();
      await get().refreshProposals();
    }
    return res;
  },

  discardProposal: async (id) => {
    const res = await get().run(`proposal:${id}:discard`, () => adminApi.discardProposal(id), {
      success: 'Proposal discarded',
    });
    if (res.ok) {
      set({ activeProposal: null });
      await get().refreshProposals();
    }
    return res;
  },

  // ---------- settings / maintenance ----------
  saveSettings: (patch) =>
    get().run('settings', () => adminApi.updateSettings(patch), {
      success: 'Settings saved',
      refresh: 'refreshSettings',
    }),

  reloadRegistry: () =>
    get().run('registry:reload', () => adminApi.reloadRegistry(), {
      success: 'Registry reloaded',
      refresh: 'refreshRegistry',
    }),

  reseedRegistry: () =>
    get().run('registry:reseed', () => adminApi.reseedRegistry(), {
      success: (r) =>
        r.created.companies || r.created.models
          ? `Restored ${r.created.companies} company/companies and ${r.created.models} model(s)`
          : 'Nothing missing — all defaults are present',
      refresh: 'refreshRegistry',
    }),
}));
