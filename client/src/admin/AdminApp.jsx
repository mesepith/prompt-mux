import { useEffect } from 'react';
import {
  Activity,
  ArrowLeft,
  Building2,
  Cpu,
  Gauge,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  Tags,
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { useAdminStore } from './useAdminStore.js';
import { ADMIN_TABS, navigateTo, navigateToAdmin } from '../lib/router.js';
import AuthModal from '../components/AuthModal.jsx';
import { Button, Callout, Toast } from './components/ui.jsx';
import OverviewPanel from './components/OverviewPanel.jsx';
import ProvidersPanel from './components/ProvidersPanel.jsx';
import ModelsPanel from './components/ModelsPanel.jsx';
import PricingPanel from './components/PricingPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import ProviderEditor from './components/ProviderEditor.jsx';
import ModelEditor from './components/ModelEditor.jsx';
import KeyPanel from './components/KeyPanel.jsx';
import PriceFetchDialog from './components/PriceFetchDialog.jsx';
import ProposalDrawer from './components/ProposalDrawer.jsx';

/**
 * The admin dashboard shell: gating, tab chrome, and the mount points for the
 * dialogs that panels open through the store (provider editor, model editor,
 * key panel, price fetch, proposal review).
 *
 * Gating here is presentation only — `/api/admin/*` re-checks the role on every
 * request (server/src/middleware/requireAdmin.js), so a user who forces this
 * component to render still can't read or change anything.
 */

const TABS = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'providers', label: 'Companies', icon: Building2 },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'pricing', label: 'Pricing', icon: Tags },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'activity', label: 'Activity', icon: Activity },
];

const PANELS = {
  overview: OverviewPanel,
  providers: ProvidersPanel,
  models: ModelsPanel,
  pricing: PricingPanel,
  settings: SettingsPanel,
  activity: ActivityPanel,
};

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-surface-950">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      {/* The chat layout isn't mounted on /admin, so the login modal has to live
          here too — otherwise the "Log in" button on the gate screen does nothing. */}
      <AuthModal />
    </div>
  );
}

function BackToChat({ children = 'Back to chat' }) {
  return (
    <Button variant="ghost" icon={ArrowLeft} onClick={() => navigateTo(null)}>
      {children}
    </Button>
  );
}

export default function AdminApp({ tab = 'overview' }) {
  const user = useStore((s) => s.user);
  const booted = useStore((s) => s.booted);
  const openAuthModal = useStore((s) => s.openAuthModal);

  const adminBooted = useAdminStore((s) => s.booted);
  const loading = useAdminStore((s) => s.loading);
  const accessDenied = useAdminStore((s) => s.accessDenied);
  const error = useAdminStore((s) => s.error);
  const toast = useAdminStore((s) => s.toast);
  const dismissToast = useAdminStore((s) => s.dismissToast);
  const boot = useAdminStore((s) => s.boot);
  const refreshRegistry = useAdminStore((s) => s.refreshRegistry);
  const isBusy = useAdminStore((s) => s.isBusy);

  const editingProvider = useAdminStore((s) => s.editingProvider);
  const editingModel = useAdminStore((s) => s.editingModel);
  const keyPanelSlug = useAdminStore((s) => s.keyPanelSlug);
  const priceFetchTarget = useAdminStore((s) => s.priceFetchTarget);
  const activeProposal = useAdminStore((s) => s.activeProposal);

  const isAdmin = user?.role === 'admin';
  const activeTab = ADMIN_TABS.includes(tab) ? tab : 'overview';

  // Load the dashboard once we know there's an admin looking at it.
  useEffect(() => {
    if (isAdmin && !adminBooted) boot();
  }, [isAdmin, adminBooted, boot]);

  if (!booted) {
    return (
      <Shell>
        <div className="flex items-center gap-2 py-24 text-sm text-zinc-500">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <div className="mx-auto max-w-md space-y-4 py-20 text-center">
          <ShieldAlert size={28} className="mx-auto text-amber-400/80" />
          <h1 className="text-lg font-semibold text-zinc-100">Admin dashboard</h1>
          <p className="text-sm leading-6 text-zinc-400">
            Sign in with an administrator account to manage LLM companies, models, pricing and API
            keys.
          </p>
          <div className="flex justify-center gap-2">
            <Button variant="primary" onClick={() => openAuthModal('login')}>
              Log in
            </Button>
            <BackToChat />
          </div>
        </div>
      </Shell>
    );
  }

  if (!isAdmin || accessDenied) {
    return (
      <Shell>
        <div className="mx-auto max-w-md space-y-4 py-20 text-center">
          <ShieldAlert size={28} className="mx-auto text-rose-400/80" />
          <h1 className="text-lg font-semibold text-zinc-100">You don’t have access</h1>
          <p className="text-sm leading-6 text-zinc-400">
            <span className="text-zinc-300">{user.email}</span> is not an administrator. Add the
            address to <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-xs">ADMIN_EMAILS</code>{' '}
            in <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-xs">server/.env</code>{' '}
            and sign in again, or run{' '}
            <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-xs">
              npm --prefix server run make-admin -- {user.email}
            </code>
            .
          </p>
          <div className="flex justify-center">
            <BackToChat />
          </div>
        </div>
      </Shell>
    );
  }

  const Panel = PANELS[activeTab] || OverviewPanel;

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="h-6 w-6 rounded-md" />
            <h1 className="text-base font-semibold text-zinc-100">PromptMux admin</h1>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            LLM companies, models, prices and API keys. Changes apply to every user immediately.
          </p>
        </div>
        <Button
          icon={RefreshCw}
          busy={isBusy('registry:reload')}
          onClick={() => refreshRegistry()}
          title="Refetch companies and models"
        >
          Refresh
        </Button>
        <BackToChat />
      </header>

      <nav className="mb-6 flex flex-wrap gap-1 rounded-xl border border-white/[0.07] bg-surface-900/60 p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => navigateToAdmin(id)}
            className={clsx(
              'flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
              id === activeTab
                ? 'bg-white/[0.08] text-zinc-100'
                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </nav>

      {error && !accessDenied && (
        <div className="mb-5">
          <Callout tone="bad">{error}</Callout>
        </div>
      )}

      {loading && !adminBooted ? (
        <div className="flex items-center gap-2 py-20 text-sm text-zinc-500">
          <Loader2 size={15} className="animate-spin" /> Loading the registry…
        </div>
      ) : (
        <Panel />
      )}

      {editingProvider && <ProviderEditor />}
      {editingModel && <ModelEditor />}
      {keyPanelSlug && <KeyPanel />}
      {priceFetchTarget && <PriceFetchDialog />}
      {activeProposal && <ProposalDrawer />}
      <Toast toast={toast} onDismiss={dismissToast} />
    </Shell>
  );
}
