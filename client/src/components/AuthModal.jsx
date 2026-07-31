import { useEffect, useRef, useState, forwardRef } from 'react';
import { X, Mail, Lock, Loader2, ArrowRight, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';

const MODES = {
  LOGIN: 'login',
  SIGNUP: 'signup',
  VERIFY: 'verify',
  FORGOT: 'forgot',
  RESET: 'reset',
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const Field = forwardRef(function Field(
  { label, icon: Icon, type = 'text', value, onChange, placeholder, autoFocus = false },
  ref
) {
  const id = `${label}-input`.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-zinc-400">
        {label}
      </label>
      <div className="relative">
        <Icon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          ref={ref}
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="w-full rounded-xl border border-white/10 bg-surface-850 py-2.5 pl-9 pr-3 text-sm text-zinc-100 outline-none transition-colors focus:border-indigo-500/50 focus:bg-surface-800 placeholder:text-zinc-600"
        />
      </div>
    </div>
  );
});

function OtpInput({ value, onChange, autoFocus = false }) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (autoFocus) setTimeout(() => inputRef.current?.focus(), 50);
  }, [autoFocus]);

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-zinc-400">6-digit verification code</label>
      <div className="relative">
        <ShieldCheck size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-indigo-400" />
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={value}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
            onChange(digits);
          }}
          placeholder="000000"
          className="w-full rounded-xl border border-white/10 bg-surface-850 py-3 pl-10 pr-3 text-center text-2xl font-semibold tracking-[0.25em] text-zinc-100 outline-none transition-all focus:border-indigo-500/50 focus:bg-surface-800 focus:ring-2 focus:ring-indigo-500/20 placeholder:text-zinc-600"
        />
      </div>
      <div className="flex justify-center gap-1.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={clsx(
              'h-1.5 w-1.5 rounded-full transition-colors',
              i < value.length ? 'bg-indigo-500' : 'bg-white/10'
            )}
          />
        ))}
      </div>
    </div>
  );
}

export default function AuthModal() {
  const {
    authModalOpen,
    authMode,
    authLoading,
    authError,
    authInfo,
    pendingOtpEmail,
    closeAuthModal,
    login,
    register,
    verifyEmail,
    forgotPassword,
    resetPassword,
    resendOtp,
    openAuthModal,
  } = useStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const initialFocus = useRef(null);

  useEffect(() => {
    if (authModalOpen) {
      setPassword('');
      setConfirmPassword('');
      setOtp('');
      if (authMode === MODES.VERIFY || authMode === MODES.RESET) {
        setEmail(pendingOtpEmail || '');
      } else {
        setEmail('');
      }
      setTimeout(() => initialFocus.current?.focus(), 50);
    }
  }, [authModalOpen, authMode, pendingOtpEmail]);

  if (!authModalOpen) return null;

  const isVerify = authMode === MODES.VERIFY;
  const isReset = authMode === MODES.RESET;

  const canSubmit = (() => {
    if (authMode === MODES.LOGIN) return isValidEmail(email) && password.length >= 6;
    if (authMode === MODES.SIGNUP)
      return isValidEmail(email) && password.length >= 6 && password === confirmPassword;
    if (authMode === MODES.FORGOT) return isValidEmail(email);
    if (authMode === MODES.VERIFY) return /^\d{6}$/.test(otp);
    if (authMode === MODES.RESET)
      return /^\d{6}$/.test(otp) && password.length >= 6 && password === confirmPassword;
    return false;
  })();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit || authLoading) return;

    if (authMode === MODES.LOGIN) {
      await login({ email, password });
    } else if (authMode === MODES.SIGNUP) {
      await register({ email, password });
    } else if (authMode === MODES.FORGOT) {
      await forgotPassword({ email });
    } else if (authMode === MODES.VERIFY) {
      await verifyEmail({ otp });
    } else if (authMode === MODES.RESET) {
      await resetPassword({ otp, password });
    }
  };

  const modeLabel = {
    [MODES.LOGIN]: 'Log in',
    [MODES.SIGNUP]: 'Sign up',
    [MODES.VERIFY]: 'Verify email',
    [MODES.FORGOT]: 'Reset password',
    [MODES.RESET]: 'Set new password',
  }[authMode];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-surface-900 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">{modeLabel}</h2>
            {(isVerify || isReset) && pendingOtpEmail && (
              <p className="mt-0.5 text-xs text-zinc-500">Code sent to {pendingOtpEmail}</p>
            )}
          </div>
          <button
            type="button"
            onClick={closeAuthModal}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          {(authMode === MODES.LOGIN || authMode === MODES.SIGNUP || authMode === MODES.FORGOT) && (
            <Field
              label="Email"
              icon={Mail}
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoFocus
              ref={initialFocus}
            />
          )}

          {(authMode === MODES.LOGIN || authMode === MODES.SIGNUP || authMode === MODES.RESET) && (
            <Field
              label={authMode === MODES.RESET ? 'New password' : 'Password'}
              icon={Lock}
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="At least 6 characters"
            />
          )}

          {(authMode === MODES.SIGNUP || authMode === MODES.RESET) && (
            <Field
              label="Confirm password"
              icon={Lock}
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Repeat the password"
            />
          )}

          {(isVerify || isReset) && <OtpInput value={otp} onChange={setOtp} autoFocus />}

          {authInfo && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-300">
              {authInfo}
            </div>
          )}

          {authError && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
              {authError}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit || authLoading}
            className={clsx(
              'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition-all',
              canSubmit && !authLoading
                ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-indigo-900/40 hover:opacity-90'
                : 'cursor-not-allowed bg-white/5 text-zinc-500'
            )}
          >
            {authLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Please wait…
              </>
            ) : (
              <>
                {modeLabel}
                <ArrowRight size={15} />
              </>
            )}
          </button>

          {(isVerify || isReset) && (
            <button
              type="button"
              onClick={resendOtp}
              disabled={authLoading}
              className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            >
              Didn’t get the code? Resend
            </button>
          )}

          <div className="flex items-center justify-center gap-3 pt-1 text-xs text-zinc-500">
            {authMode === MODES.LOGIN ? (
              <>
                <span>No account?</span>
                <button
                  type="button"
                  onClick={() => openAuthModal(MODES.SIGNUP)}
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Sign up
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => openAuthModal(MODES.FORGOT)}
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Forgot password
                </button>
              </>
            ) : authMode === MODES.SIGNUP ? (
              <>
                <span>Already have an account?</span>
                <button
                  type="button"
                  onClick={() => openAuthModal(MODES.LOGIN)}
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Log in
                </button>
              </>
            ) : authMode === MODES.FORGOT ? (
              <button
                type="button"
                onClick={() => openAuthModal(MODES.LOGIN)}
                className="text-indigo-400 hover:text-indigo-300"
              >
                Back to log in
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
