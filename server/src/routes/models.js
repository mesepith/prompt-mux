import { Router } from 'express';
import { COMPANIES, MODELS, isCompanyAvailable } from '../config/registry.js';

const router = Router();

// GET /api/models — registry + which companies have API keys configured.
router.get('/', (req, res) => {
  res.json({
    companies: COMPANIES.map((c) => ({ ...c, available: isCompanyAvailable(c) })),
    models: MODELS,
  });
});

export default router;
