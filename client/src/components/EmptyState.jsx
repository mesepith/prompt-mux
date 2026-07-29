import { Gamepad2, LayoutTemplate, LineChart, Wand2 } from 'lucide-react';
import { useStore } from '../store/useStore.js';

const SUGGESTIONS = [
  {
    icon: LayoutTemplate,
    title: 'Landing page',
    prompt: 'Build a beautiful landing page for a specialty coffee brand called Ember Roast',
  },
  {
    icon: Gamepad2,
    title: 'Playable game',
    prompt: 'Create a playable tic-tac-toe game with score tracking',
  },
  {
    icon: LineChart,
    title: 'Dashboard',
    prompt: 'Make an interactive sales dashboard with animated charts (pure CSS/JS, sample data)',
  },
  {
    icon: Wand2,
    title: 'Just chat',
    prompt: 'Explain the difference between GPT, Claude, Gemini and Kimi models in a simple table',
  },
];

export default function EmptyState() {
  const { sendMessage, companies, models } = useStore();
  const ready = companies.filter((c) => c.available);

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-2xl text-center animate-fade-in">
        <img src="/logo.svg" alt="" className="mx-auto mb-6 h-16 w-16 rounded-2xl shadow-2xl shadow-indigo-950/60" />
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          One chat. <span className="text-gradient">Every model.</span>
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-7 text-zinc-400">
          Talk to OpenAI, Anthropic, Google and Moonshot models in a single conversation —
          switch models mid-chat, and watch websites, games and tools come alive in the
          artifact panel.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map(({ icon: Icon, title, prompt }) => (
            <button
              key={title}
              type="button"
              onClick={() => sendMessage(prompt)}
              className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-left transition-all hover:border-indigo-500/30 hover:bg-indigo-500/[0.05]"
            >
              <Icon size={18} className="mb-2 text-indigo-400" />
              <div className="text-sm font-semibold text-zinc-200">{title}</div>
              <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-zinc-500">{prompt}</div>
            </button>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {companies.map((c) => {
            const count = models.filter((m) => m.company === c.id).length;
            return (
              <span
                key={c.id}
                className="flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-400"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: c.available ? c.color : '#3f3f46' }}
                />
                {c.name.replace(' (no key needed)', '')}
                <span className="text-zinc-600">· {count}</span>
              </span>
            );
          })}
        </div>
        {ready.length <= 1 && (
          <p className="mt-4 text-xs text-zinc-600">
            Only the offline demo model is active. Add keys to{' '}
            <code className="rounded bg-white/5 px-1.5 py-0.5 text-zinc-400">server/.env</code>{' '}
            and restart to unlock real models.
          </p>
        )}
      </div>
    </div>
  );
}
