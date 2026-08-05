import { Router } from 'express';
import { Artifact } from '../models/Artifact.js';
import { renderArtifactPage, renderMissingPage } from '../lib/artifactPage.js';
import { isPublicId, readSessionCookie } from '../lib/publicArtifact.js';

const router = Router();

/**
 * GET /a/:publicId — the public artifact page.
 *
 * Mounted outside /api and BEFORE the SPA fallback in index.js, so the link is
 * a real page load rather than the chat app: this is what someone gets when the
 * owner sends them the URL, and there is nothing of the app on it (see
 * lib/artifactPage.js for why the artifact only ever runs inside a sandboxed
 * frame).
 *
 * Not shared and not yours renders exactly the same page as "no such id" —
 * telling the two apart would turn the id space into something worth scanning.
 */

/**
 * Ownership for a *page view*. Unlike the API this can only use what a plain
 * navigation carries: the auth cookie, or the anonymous session cookie written
 * at publish time.
 */
function ownsArtifact(req, artifact) {
  if (req.userId && String(artifact.userId) === String(req.userId)) return true;
  const session = readSessionCookie(req);
  if (session && artifact.sessionId === session) return true;
  return false;
}

router.get('/:publicId', async (req, res, next) => {
  try {
    const miss = () =>
      res.status(404).type('html').set('Cache-Control', 'no-store').send(renderMissingPage());

    if (!isPublicId(req.params.publicId)) return miss();
    const artifact = await Artifact.findOne({ publicId: req.params.publicId }).lean();
    if (!artifact) return miss();

    const isOwner = ownsArtifact(req, artifact);
    if (!artifact.shared && !isOwner) return miss();

    res
      .type('html')
      // A shared page is identical for every viewer, so it may be cached briefly;
      // a private one must not be stored anywhere.
      .set('Cache-Control', artifact.shared ? 'public, max-age=60' : 'private, no-store')
      .send(renderArtifactPage(artifact));

    // Cheap popularity counter, after the response and never blocking it.
    if (!isOwner) {
      Artifact.updateOne(
        { _id: artifact._id },
        { $inc: { views: 1 }, $set: { lastViewedAt: new Date() } }
      ).catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});

export default router;
