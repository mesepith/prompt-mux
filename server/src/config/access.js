/**
 * Who may create an account.
 *
 * PromptMux runs on the owner's provider keys, so an open sign-up form on a public
 * host means strangers can spend the owner's money and make the server email
 * arbitrary addresses. Set ALLOWED_EMAILS in server/.env to close it:
 *
 *   ALLOWED_EMAILS=me@example.com,you@example.com   # exact addresses
 *   ALLOWED_EMAILS=@mycompany.com                   # a whole domain
 *   ALLOWED_EMAILS=me@example.com,@mycompany.com    # both
 *
 * Empty or unset keeps registration open — the previous behaviour, fine for a
 * laptop or an intentionally public instance.
 */
export function allowedEmailRules() {
  const raw = process.env.ALLOWED_EMAILS || '';
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function registrationIsOpen() {
  return allowedEmailRules().length === 0;
}

export function isRegistrationAllowed(email) {
  const rules = allowedEmailRules();
  if (!rules.length) return true;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return rules.some((rule) =>
    rule.startsWith('@') ? normalized.endsWith(rule) : normalized === rule
  );
}
