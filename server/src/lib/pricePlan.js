/**
 * Works out which pages a "fetch prices for this company" click has to read.
 *
 * Most vendors put every model's price on one page, so one fetch does the job.
 * Some (Kimi, Qwen) publish a page per model or per model family, and for those a
 * company-level fetch has to read several pages — Kimi's four models live on three
 * pages, two of them sharing `chat-k27-code`.
 *
 * Pure and side-effect free so the cost of a click can be shown *before* it is
 * spent: each entry in `calls` is exactly one paid model call.
 */

/** Distinct URLs are compared after trimming; everything else is left alone. */
function normalizeUrl(url) {
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

/**
 * @param {object} company  registry company object (needs `pricingUrl`, `name`)
 * @param {Array}  models   registry model objects for that company
 * @param {object} [opts]
 * @param {boolean} [opts.includeInactive=false]  price models that are switched off
 * @param {number}  [opts.maxCalls=12]            hard ceiling on pages per click
 * @returns {{
 *   mode: 'company'|'per-model'|'none',
 *   calls: Array<{ url: string, modelSlugs: string[], modelNames: string[] }>,
 *   uncovered: Array<{ slug: string, name: string }>,
 *   dropped: number,
 * }}
 */
export function buildFetchPlan(company, models, { includeInactive = false, maxCalls = 12 } = {}) {
  const companyUrl = normalizeUrl(company?.pricingUrl);
  const relevant = (Array.isArray(models) ? models : []).filter(
    (m) => m && (includeInactive || m.active !== false)
  );

  // A company page prices everything at once — always the cheaper route, so it
  // wins whenever it exists. Per-model URLs stay available for a single-model
  // fetch, which is what the model row's own button does.
  if (companyUrl) {
    return {
      mode: 'company',
      calls: [
        {
          url: companyUrl,
          modelSlugs: relevant.map((m) => m.id),
          modelNames: relevant.map((m) => m.name),
        },
      ],
      uncovered: [],
      dropped: 0,
    };
  }

  // No company page: group the models by their own URL so two models sharing a
  // page cost one call, not two.
  const groups = new Map();
  const uncovered = [];
  for (const m of relevant) {
    const url = normalizeUrl(m.pricingUrl);
    if (!url) {
      uncovered.push({ slug: m.id, name: m.name });
      continue;
    }
    if (!groups.has(url)) groups.set(url, { url, modelSlugs: [], modelNames: [] });
    const group = groups.get(url);
    group.modelSlugs.push(m.id);
    group.modelNames.push(m.name);
  }

  const all = [...groups.values()];
  const calls = all.slice(0, Math.max(0, maxCalls));
  return {
    mode: calls.length ? 'per-model' : 'none',
    calls,
    uncovered,
    // Never silently truncate a plan: the caller reports this so nobody thinks
    // every model was priced when some pages were skipped.
    dropped: all.length - calls.length,
  };
}

/**
 * Rough cost of running a plan, from the admin model's own rate.
 *
 * A pricing page runs about 1.5k-6k input tokens and a few hundred out; those
 * bounds come from measuring the real pages (DeepSeek 1.6k, Google 21k is the
 * outlier). Deliberately a range, not a figure — it is shown to a human deciding
 * whether to click, not used for accounting. The ledger records what was actually
 * spent.
 */
export function estimatePlanCost(plan, adminModel) {
  const calls = plan?.calls?.length || 0;
  const price = adminModel?.price;
  if (!calls || !price || typeof price.in !== 'number' || typeof price.out !== 'number') {
    return { calls, lowUsd: null, highUsd: null };
  }
  const per = (inTok, outTok) => (inTok * price.in + outTok * price.out) / 1e6;
  return {
    calls,
    lowUsd: per(1500, 200) * calls,
    highUsd: per(6000, 800) * calls,
  };
}
