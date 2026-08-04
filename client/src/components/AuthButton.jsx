import { User, LogOut, ShieldCheck } from 'lucide-react';
import { useStore } from '../store/useStore.js';
import { navigateToAdmin } from '../lib/router.js';

export default function AuthButton() {
  const user = useStore((s) => s.user);
  const adminPath = useStore((s) => s.adminPath);
  const openAuthModal = useStore((s) => s.openAuthModal);
  const logout = useStore((s) => s.logout);

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
            <User size={13} />
          </span>
          <span className="min-w-0 truncate text-xs text-zinc-300">{user.email}</span>
        </div>
        {/* Admins only, and only once the private dashboard segment has arrived
            from /api/auth/me — the link is the only place it surfaces in the UI. */}
        {user.role === 'admin' && adminPath && (
          <button
            type="button"
            onClick={() => navigateToAdmin('overview')}
            title="Admin dashboard"
            className="rounded-xl p-2 text-indigo-400/80 hover:bg-white/5 hover:text-indigo-300"
          >
            <ShieldCheck size={15} />
          </button>
        )}
        <button
          type="button"
          onClick={logout}
          title="Log out"
          className="rounded-xl p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
        >
          <LogOut size={15} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openAuthModal('login')}
      className="rounded-xl bg-white/[0.04] px-4 py-2 text-xs font-semibold text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-zinc-100"
    >
      Log in / Sign up
    </button>
  );
}
