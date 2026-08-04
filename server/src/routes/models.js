import { Router } from 'express';
import { listCompanies, listModels, isCompanyAvailable } from '../config/registry.js';

const router = Router();

/**
 * GET /api/models — the registry as the chat client sees it.
 *
 * Only *active* companies and models are returned: deactivating something in the
 * admin dashboard has to remove it from the picker for everyone, immediately.
 * `available` still means "a key is configured" — that's what renders the padlock.
 *
 * The company's env-var name and base URL are deliberately not included; the
 * chat client has no use for them and they describe the server's configuration.
 */
router.get('/', (req, res) => {
  res.json({
    companies: listCompanies().map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      docsUrl: c.docsUrl,
      available: isCompanyAvailable(c),
    })),
    models: listModels().map((m) => ({
      id: m.id,
      company: m.company,
      name: m.name,
      apiModel: m.apiModel,
      tagline: m.tagline,
      ...(m.price ? { price: m.price } : {}),
      currency: m.currency,
      vision: m.vision,
      pdf: m.pdf,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
    })),
  });
});

export default router;
