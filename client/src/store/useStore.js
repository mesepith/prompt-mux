import { create } from 'zustand';
import { api, streamMessage, setApiSessionId, setAdminApiPath } from '../api/client.js';
import { extractArtifacts } from '../lib/artifacts.js';
import { currentRouteId, navigateTo, setAdminPath } from '../lib/router.js';

/**
 * The dashboard's private URL segment arrives only in /api/auth/me, and only for
 * an admin. Push it into the router and the API client together so a single call
 * site owns the "we now know where the dashboard is" transition.
 */
function applyAdminPath(adminPath) {
  setAdminPath(adminPath || null);
  setAdminApiPath(adminPath || null);
  return adminPath || null;
}

const SESSION_KEY = 'pm_session_id';

function getOrCreateSessionId() {
  if (typeof window === 'undefined') return null;
  let id = window.localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export const useStore = create((set, get) => ({
  // registry
  companies: [],
  models: [],
  // conversations
  conversations: [],
  currentId: null,
  messages: [],
  selectedModelId: null,
  selectedVisionModelId: null, // draft choice for new chats (conversation not created yet)
  // streaming
  streaming: false,
  streamingContent: '',
  statusText: null,
  abortController: null,
  // composer attachments (shared by composer + drag-and-drop zone)
  attachments: [],
  attachError: null,
  // ui
  sidebarOpen: typeof window !== 'undefined' ? window.innerWidth >= 1024 : true,
  activeArtifact: null,
  // point-and-edit (artifact panel)
  artifactEditBusy: false,
  artifactEditError: null,
  artifactEditNote: null,
  // published artifact links (/a/<publicId>) — see openArtifactShare below
  artifactShareOpen: false,
  artifactShare: null, // { publicId, path, shared, messageId, artifactIndex, … }
  artifactShareBusy: false,
  artifactShareError: null,
  activeAttachment: null, // { kind, dataUrl, name } — opens the lightbox viewer
  booted: false,
  bootError: null,
  linkError: null, // a shared/bookmarked /c/<id> link that no longer resolves
  // auth
  sessionId: null,
  user: null,
  adminPath: null, // private dashboard segment; only ever set for an admin
  anonymousUsage: null, // { messageCount, limit, blocked }
  authModalOpen: false,
  authMode: 'login', // 'login' | 'signup' | 'forgot'
  authLoading: false,
  authError: null,
  authInfo: null,
  pendingOtpEmail: null,
  pendingMessage: null, // { content, attachments } queued when anonymous limit is hit
  // sharing
  shareModalOpen: false,
  currentConversationIsOwner: false,
  currentConversationShared: false,

  // ---------- helpers ----------
  modelById: (id) => get().models.find((m) => m.id === id),
  companyById: (id) => get().companies.find((c) => c.id === id),
  companyForModel: (modelId) => {
    const model = get().modelById(modelId);
    return model ? get().companyById(model.company) : null;
  },

  anonymousLimitReached: () => {
    const u = get().anonymousUsage;
    return !get().user && !!u && u.blocked;
  },

  // ---------- bootstrap ----------
  bootstrap: async ({ skipDeepLink = false } = {}) => {
    try {
      const sessionId = getOrCreateSessionId();
      setApiSessionId(sessionId);
      set({ sessionId });

      const [{ companies, models }, auth, conversations] = await Promise.all([
        api.models(),
        api.authMe(),
        api.listConversations(),
      ]);
      const firstAvailable = models.find(
        (m) => companies.find((c) => c.id === m.company)?.available
      );
      set({
        companies,
        models,
        user: auth.user,
        adminPath: applyAdminPath(auth.adminPath),
        anonymousUsage: auth.anonymous,
        conversations,
        selectedModelId: firstAvailable?.id || 'demo-artist',
        booted: true,
      });
      // Deep link: /c/<id> opens that chat straight away (bookmark / shared link).
      const routeId = skipDeepLink ? null : currentRouteId();
      if (routeId) await get().selectConversation(routeId, { updateUrl: false });
    } catch (err) {
      set({ bootError: err.message, booted: true });
    }
  },

  // Back/forward buttons: mirror whatever the URL now says.
  handleRouteChange: (id) => {
    if (id === get().currentId) return;
    if (id) get().selectConversation(id, { updateUrl: false });
    else get().newChat({ updateUrl: false });
  },

  dismissLinkError: () => set({ linkError: null }),

  // ---------- auth ----------
  openAuthModal: (mode = 'login') =>
    set({ authModalOpen: true, authMode: mode, authError: null, authInfo: null }),
  closeAuthModal: () =>
    set({ authModalOpen: false, authError: null, authInfo: null, pendingOtpEmail: null }),

  openShareModal: () => set({ shareModalOpen: true }),
  closeShareModal: () => set({ shareModalOpen: false }),
  setConversationShared: async (shared) => {
    const id = get().currentId;
    if (!id) return;
    const convo = await api.shareConversation(id, shared);
    set((s) => ({
      currentConversationShared: convo.shared,
      conversations: s.conversations.map((c) => (c._id === id ? convo : c)),
    }));
  },

  refreshAuth: async () => {
    try {
      const auth = await api.authMe();
      set({
        user: auth.user,
        adminPath: applyAdminPath(auth.adminPath),
        anonymousUsage: auth.anonymous,
      });
    } catch (err) {
      // ignore — the next request will fail cleanly
    }
  },

  login: async ({ email, password }) => {
    set({ authLoading: true, authError: null });
    try {
      const result = await api.login(email, password);
      if (result.requiresVerification) {
        set({
          authLoading: false,
          authMode: 'verify',
          pendingOtpEmail: result.email,
          authInfo: 'Your email is not verified yet. A new code has been sent — enter it below.',
        });
        return { ok: true, requiresVerification: true };
      }
      const { user } = result;
      const conversations = await api.listConversations();
      set({
        user,
        adminPath: applyAdminPath(result.adminPath),
        anonymousUsage: null,
        conversations,
        authLoading: false,
        authModalOpen: false,
        authError: null,
      });
      await get()._flushPendingMessage();
      return { ok: true };
    } catch (err) {
      set({ authLoading: false, authError: err.message });
      return { ok: false, error: err.message };
    }
  },

  register: async ({ email, password }) => {
    set({ authLoading: true, authError: null });
    try {
      await api.register(email, password);
      set({
        authLoading: false,
        authMode: 'verify',
        pendingOtpEmail: email,
        authInfo: 'Enter the 6-digit code sent to your email.',
      });
      return { ok: true };
    } catch (err) {
      set({ authLoading: false, authError: err.message });
      return { ok: false, error: err.message };
    }
  },

  verifyEmail: async ({ otp }) => {
    const email = get().pendingOtpEmail;
    if (!email) {
      set({ authError: 'Session expired. Please start again.' });
      return { ok: false };
    }
    set({ authLoading: true, authError: null });
    try {
      const result = await api.verifyEmail(email, otp);
      const { user } = result;
      const conversations = await api.listConversations();
      set({
        user,
        adminPath: applyAdminPath(result.adminPath),
        anonymousUsage: null,
        conversations,
        authLoading: false,
        authModalOpen: false,
        authError: null,
        pendingOtpEmail: null,
        authInfo: null,
      });
      await get()._flushPendingMessage();
      return { ok: true };
    } catch (err) {
      set({ authLoading: false, authError: err.message });
      return { ok: false, error: err.message };
    }
  },

  forgotPassword: async ({ email }) => {
    set({ authLoading: true, authError: null });
    try {
      await api.forgotPassword(email);
      set({
        authLoading: false,
        authMode: 'reset',
        pendingOtpEmail: email,
        authInfo: 'Enter the 6-digit code and your new password.',
      });
      return { ok: true };
    } catch (err) {
      // No account for that address: send them to sign-up with the email kept,
      // instead of leaving them on a screen waiting for a code that never comes.
      if (err.body?.noAccount) {
        set({
          authLoading: false,
          authMode: 'signup',
          pendingOtpEmail: null,
          authInfo: null,
          authError: 'No account uses that email — create one below.',
        });
        return { ok: false, error: err.message };
      }
      set({ authLoading: false, authError: err.message });
      return { ok: false, error: err.message };
    }
  },

  resetPassword: async ({ otp, password }) => {
    const email = get().pendingOtpEmail;
    if (!email) {
      set({ authError: 'Session expired. Please start again.' });
      return { ok: false };
    }
    set({ authLoading: true, authError: null });
    try {
      const result = await api.resetPassword(email, otp, password);
      const { user } = result;
      const conversations = await api.listConversations();
      set({
        user,
        adminPath: applyAdminPath(result.adminPath),
        anonymousUsage: null,
        conversations,
        authLoading: false,
        authModalOpen: false,
        authError: null,
        pendingOtpEmail: null,
        authInfo: null,
      });
      await get()._flushPendingMessage();
      return { ok: true };
    } catch (err) {
      set({ authLoading: false, authError: err.message });
      return { ok: false, error: err.message };
    }
  },

  resendOtp: async () => {
    const email = get().pendingOtpEmail;
    if (!email) return { ok: false, error: 'No pending verification' };
    const purpose = get().authMode === 'reset' ? 'forgot-password' : 'register';
    set({ authLoading: true, authError: null });
    try {
      await api.resendOtp(email, purpose);
      set({ authLoading: false, authInfo: 'A new code has been sent.' });
      return { ok: true };
    } catch (err) {
      // Clear authInfo too, or the green "enter the code" banner keeps sitting
      // above the red failure and the screen contradicts itself.
      set({ authLoading: false, authInfo: null, authError: err.message });
      return { ok: false, error: err.message };
    }
  },

  logout: async () => {
    await api.logout();
    const sessionId = crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, sessionId);
    setApiSessionId(sessionId);
    // Forget the private dashboard path on the way out, so it can't be reached
    // (or read out of the store) by whoever uses this browser next.
    applyAdminPath(null);
    set({
      user: null,
      adminPath: null,
      sessionId,
      conversations: [],
      messages: [],
      currentId: null,
      pendingMessage: null,
      linkError: null,
    });
    // After logout, the previous chat is owned by the now-signed-out account;
    // trying to deep-link back into it would fail and show a scary error.
    // Reload global state (models, anonymous limit) and start a fresh new chat.
    await get().bootstrap({ skipDeepLink: true });
    get().newChat({ updateUrl: true });
  },

  _flushPendingMessage: async () => {
    const pending = get().pendingMessage;
    if (!pending) return;
    set({ pendingMessage: null });
    // Restore attachments so sendMessage can consume them.
    set({ attachments: pending.attachments });
    await get().sendMessage(pending.content);
  },

  // ---------- attachments (composer + drop zone) ----------
  addAttachments: (files) => {
    const MAX_IMAGES = 4;
    const MAX_PDFS = 2;
    const MAX_DOCS = 2;
    const MAX_SHEETS = 2;
    const MAX_IMAGE_MB = 5;
    const MAX_PDF_MB = 8;
    const MAX_DOC_MB = 8;
    // Lower than docs on purpose: the server streams spreadsheets rather than
    // loading the workbook, but the base64 payload is still resident.
    const MAX_SHEET_MB = 5;
    set({ attachError: null });
    let imgRoom = MAX_IMAGES - get().attachments.filter((a) => a.kind === 'image').length;
    let pdfRoom = MAX_PDFS - get().attachments.filter((a) => a.kind === 'pdf').length;
    let docRoom = MAX_DOCS - get().attachments.filter((a) => a.kind === 'doc').length;
    let sheetRoom = MAX_SHEETS - get().attachments.filter((a) => a.kind === 'sheet').length;
    const fail = (msg) => set({ attachError: msg });

    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(file.name);
      const isDoc = file.type === 'application/msword' || /\.doc$/i.test(file.name);
      const isImage = file.type.startsWith('image/');
      const isSheet = /\.(xlsx|xlsm|csv|tsv)$/i.test(file.name)
        || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || file.type === 'text/csv';
      // Legacy .xls needs a parser we deliberately do not ship — say so plainly
      // rather than letting the server reject it after the upload.
      if (/\.xls$/i.test(file.name) || file.type === 'application/vnd.ms-excel') {
        fail(`"${file.name}" is a legacy .xls — please re-save it as .xlsx`);
        continue;
      }
      if (!isPdf && !isDocx && !isDoc && !isImage && !isSheet) {
        fail('Only images, PDFs, Word docs and spreadsheets (.xlsx/.csv) are supported');
        continue;
      }
      if (isSheet) {
        if (sheetRoom <= 0) { fail(`Max ${MAX_SHEETS} spreadsheets per message`); continue; }
        if (file.size > MAX_SHEET_MB * 1024 * 1024) { fail(`"${file.name}" is over ${MAX_SHEET_MB} MB`); continue; }
        sheetRoom -= 1;
      } else if (isDocx || isDoc) {
        if (docRoom <= 0) { fail(`Max ${MAX_DOCS} documents per message`); continue; }
        if (file.size > MAX_DOC_MB * 1024 * 1024) { fail(`"${file.name}" is over ${MAX_DOC_MB} MB`); continue; }
        docRoom -= 1;
      } else if (isPdf) {
        if (pdfRoom <= 0) { fail(`Max ${MAX_PDFS} PDFs per message`); continue; }
        if (file.size > MAX_PDF_MB * 1024 * 1024) { fail(`"${file.name}" is over ${MAX_PDF_MB} MB`); continue; }
        pdfRoom -= 1;
      } else {
        if (imgRoom <= 0) { fail(`Max ${MAX_IMAGES} images per message`); continue; }
        if (file.size > MAX_IMAGE_MB * 1024 * 1024) { fail(`"${file.name}" is over ${MAX_IMAGE_MB} MB`); continue; }
        imgRoom -= 1;
      }
      const kind = isSheet ? 'sheet' : isDocx || isDoc ? 'doc' : isPdf ? 'pdf' : 'image';
      const reader = new FileReader();
      reader.onload = () =>
        set((s) => ({
          attachments: [
            ...s.attachments,
            { kind, dataUrl: reader.result, mimeType: file.type || 'application/octet-stream', name: file.name },
          ],
        }));
      reader.readAsDataURL(file);
    }
  },
  removeAttachment: (index) =>
    set((s) => ({ attachments: s.attachments.filter((_, i) => i !== index) })),
  clearAttachments: () => set({ attachments: [], attachError: null }),

  // ---------- conversations ----------
  // `updateUrl: false` when the URL is already the source of truth (deep link,
  // back/forward) — otherwise every selection pushes /c/<id> onto the history.
  selectConversation: async (id, { updateUrl = true } = {}) => {
    if (get().streaming) get().stopStreaming();
    if (updateUrl) navigateTo(id);
    set({
      currentId: id,
      activeArtifact: null,
      messages: [],
      attachments: [],
      attachError: null,
      linkError: null,
      currentConversationIsOwner: false,
      currentConversationShared: false,
    });
    try {
      const convo = await api.getConversation(id);
      // Guard against a fast second click.
      if (get().currentId !== id) return;
      const { messages, ...meta } = convo;
      set((s) => ({
        messages,
        selectedModelId: convo.modelId,
        currentConversationIsOwner: Boolean(convo.isOwner),
        currentConversationShared: Boolean(convo.shared),
        // A link opened in another tab/window may point at a chat this list
        // hasn't seen yet — fold it in so the sidebar and title bar match.
        conversations: s.conversations.some((c) => c._id === id)
          ? s.conversations
          : [meta, ...s.conversations],
      }));
    } catch (err) {
      if (get().currentId !== id) return;
      set({ currentId: null, messages: [], currentConversationIsOwner: false, currentConversationShared: false, linkError: `Can't open that chat link — ${err.message}` });
      navigateTo(null, { replace: true });
    }
  },

  newChat: ({ updateUrl = true } = {}) => {
    if (get().streaming) get().stopStreaming();
    if (updateUrl) navigateTo(null);
    set({
      currentId: null,
      messages: [],
      activeArtifact: null,
      attachments: [],
      attachError: null,
      linkError: null,
      currentConversationIsOwner: false,
      currentConversationShared: false,
    });
  },

  deleteConversation: async (id) => {
    await api.deleteConversation(id);
    if (get().currentId === id) navigateTo(null, { replace: true });
    set((s) => ({
      conversations: s.conversations.filter((c) => c._id !== id),
      ...(s.currentId === id ? { currentId: null, messages: [], activeArtifact: null } : {}),
    }));
  },

  renameConversation: async (id, title) => {
    const convo = await api.updateConversation(id, { title });
    set((s) => ({
      conversations: s.conversations.map((c) => (c._id === id ? convo : c)),
    }));
  },

  // ---------- model switching (works mid-conversation) ----------
  setModel: async (modelId) => {
    set({ selectedModelId: modelId });
    const { currentId, conversations, currentConversationIsOwner } = get();
    if (!currentId || !currentConversationIsOwner) return;
    const convo = await api.updateConversation(currentId, { modelId });
    set({
      conversations: conversations.map((c) => (c._id === currentId ? convo : c)),
    });
  },

  // Vision model used ONLY to describe images when the chat model can't see them.
  // Works before the conversation exists: the draft is persisted on first send.
  setVisionModel: async (visionModelId) => {
    set({ selectedVisionModelId: visionModelId });
    const { currentId, conversations, currentConversationIsOwner } = get();
    if (!currentId || !currentConversationIsOwner) return;
    const convo = await api.updateConversation(currentId, { visionModelId });
    set({
      conversations: conversations.map((c) => (c._id === currentId ? convo : c)),
    });
  },

  // ---------- sending ----------
  sendMessage: async (content) => {
    const text = content.trim();
    const { streaming, selectedModelId, attachments, user } = get();
    if ((!text && !attachments.length) || streaming) return;

    // Anonymous message limit: queue the message and ask the user to log in.
    if (!user && get().anonymousLimitReached()) {
      set({
        pendingMessage: { content: text, attachments: [...attachments] },
        authModalOpen: true,
        authMode: 'login',
        authError: 'You have reached the free message limit. Sign up or log in to continue.',
      });
      return;
    }

    let { currentId } = get();

    // First message of a brand-new chat: create the conversation on the fly.
    if (!currentId) {
      const convo = await api.createConversation(
        selectedModelId,
        get().selectedVisionModelId || undefined
      );
      currentId = convo._id;
      set((s) => ({
        currentId,
        conversations: [convo, ...s.conversations],
        messages: [],
        // We just created it, so we own it. Without this the fork branch below
        // sees the store default (false), tries to fork a chat that isn't
        // shared, gets a 404 and the message is never sent.
        currentConversationIsOwner: true,
        currentConversationShared: false,
      }));
      // The chat now has a permanent link — swap `/` for it (replace, not push,
      // so Back leaves the app instead of returning to an empty new chat).
      navigateTo(currentId, { replace: true });
    }

    // Viewing a shared chat we don't own: fork it to a private copy before writing.
    // This guarantees the original chat ID is never reused for someone else's messages.
    if (currentId && !get().currentConversationIsOwner) {
      const forked = await api.forkConversation(currentId);
      currentId = forked._id;
      set((s) => ({
        currentId,
        messages: forked.messages,
        conversations: s.conversations.some((c) => c._id === currentId)
          ? s.conversations
          : [forked, ...s.conversations],
        currentConversationIsOwner: true,
        currentConversationShared: false,
      }));
      navigateTo(currentId, { replace: true });
    }

    const tempUser = {
      _id: `tmp-${Date.now()}`,
      role: 'user',
      content: text,
      attachments,
      createdAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    set((s) => ({
      messages: [...s.messages, tempUser],
      streaming: true,
      streamingContent: '',
      statusText: null,
      abortController: controller,
      attachments: [], // consumed into the message
      attachError: null,
    }));

    const finish = (message) => {
      const artifacts = extractArtifacts(message?.content || '', message?._id);
      set((s) => ({
        messages: [...s.messages, message],
        streaming: false,
        streamingContent: '',
        statusText: null,
        abortController: null,
        // Auto-open the artifact panel, Claude-style, when one was produced.
        ...(artifacts.length ? { activeArtifact: artifacts[0] } : {}),
      }));
    };

    try {
      await streamMessage({
        conversationId: currentId,
        content: text,
        modelId: get().selectedModelId,
        images: attachments.filter((a) => a.kind === 'image').map((a) => a.dataUrl),
        pdfs: attachments
          .filter((a) => a.kind === 'pdf')
          .map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
        docs: attachments
          .filter((a) => a.kind === 'doc')
          .map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
        sheets: attachments
          .filter((a) => a.kind === 'sheet')
          .map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === 'start') {
            // Swap the optimistic user message for the saved one, refresh list meta.
            set((s) => ({
              messages: s.messages.map((m) => (m._id === tempUser._id ? ev.userMessage : m)),
              conversations: s.conversations
                .map((c) => (c._id === currentId ? ev.conversation : c))
                .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)),
            }));
          } else if (ev.type === 'status') {
            set({ statusText: ev.content });
          } else if (ev.type === 'token') {
            set((s) => ({ streamingContent: s.streamingContent + ev.content }));
          } else if (ev.type === 'reset') {
            // A targeted artifact edit was attempted and couldn't be applied, so
            // the server is starting over with a full rewrite. Clear what the
            // abandoned attempt already streamed, or the rewrite appends to it.
            set({ streamingContent: '' });
          } else if (ev.type === 'done') {
            finish(ev.message);
            get().refreshAuth();
          } else if (ev.type === 'error') {
            finish(ev.message);
            get().refreshAuth();
          }
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return; // server already saved partial state
      // If the server rejected the send because the anonymous limit was reached,
      // queue the message and show the auth modal.
      if (err.code === 'ANONYMOUS_LIMIT_REACHED') {
        set((s) => ({
          messages: s.messages.filter((m) => m._id !== tempUser._id),
          streaming: false,
          streamingContent: '',
          statusText: null,
          abortController: null,
          attachments: [...attachments],
          pendingMessage: { content: text, attachments: [...attachments] },
          authModalOpen: true,
          authMode: 'login',
          authError: err.message,
          anonymousUsage: { ...(s.anonymousUsage || {}), blocked: true },
        }));
        return;
      }
      finish({
        _id: `err-${Date.now()}`,
        role: 'assistant',
        content: '',
        modelId: get().selectedModelId,
        error: err.message,
        createdAt: new Date().toISOString(),
      });
    }
  },

  stopStreaming: () => {
    const { abortController } = get();
    if (abortController) abortController.abort();
    set({ streaming: false, statusText: null, abortController: null });
  },

  // ---------- artifacts / ui ----------
  openArtifact: (artifact) =>
    set({ activeArtifact: artifact, artifactEditError: null, artifactEditNote: null }),
  closeArtifact: () =>
    set({
      activeArtifact: null,
      artifactEditError: null,
      artifactEditNote: null,
      artifactShareOpen: false,
    }),

  /**
   * The published link for the artifact currently in the panel, or null.
   *
   * Matched on (messageId, index) rather than cleared everywhere the panel
   * re-points: a point-edit saves a NEW message, so the previous version's link
   * still exists and still serves that version — it just isn't this artifact's
   * link any more, and must not be offered as one.
   */
  activeArtifactShare: () => {
    const { artifactShare, activeArtifact } = get();
    if (!artifactShare || !activeArtifact?.messageId) return null;
    const matches =
      artifactShare.messageId === activeArtifact.messageId &&
      artifactShare.artifactIndex === (activeArtifact.index ?? 0);
    return matches ? artifactShare : null;
  },

  /** True when this artifact can get a link at all — saved, and in your own chat. */
  canPublishActiveArtifact: () => {
    const { activeArtifact, currentId, currentConversationIsOwner } = get();
    return Boolean(activeArtifact?.messageId && currentId && currentConversationIsOwner);
  },

  /**
   * Mint (or re-fetch) the `/a/<publicId>` link for the open artifact. The
   * server is the one that reads the code out of the stored message, so this
   * only says *which* artifact; it is idempotent, and the link starts private.
   * Returns the share record; throws with a message worth showing.
   */
  publishActiveArtifact: async () => {
    const { activeArtifact, currentId } = get();
    if (!get().canPublishActiveArtifact()) {
      throw new Error(
        activeArtifact?.messageId
          ? 'Only the chat owner can create a link for this artifact.'
          : 'This artifact gets a link once the reply is saved.'
      );
    }
    // The user can move on while this is in flight; remember what it was for.
    const requestMessageId = activeArtifact.messageId;
    const requestIndex = activeArtifact.index ?? 0;
    set({ artifactShareBusy: true, artifactShareError: null });
    try {
      const share = await api.publishArtifact({
        conversationId: currentId,
        messageId: requestMessageId,
        artifactIndex: requestIndex,
      });
      set({ artifactShare: share, artifactShareBusy: false });
      return share;
    } catch (err) {
      set({ artifactShareBusy: false, artifactShareError: err.message });
      throw err;
    }
  },

  /** Opens the share dialog, minting the link if this artifact has none yet. */
  openArtifactShare: async () => {
    set({ artifactShareOpen: true, artifactShareError: null });
    if (get().activeArtifactShare()) return;
    try {
      await get().publishActiveArtifact();
    } catch {
      /* already surfaced as artifactShareError */
    }
  },
  closeArtifactShare: () => set({ artifactShareOpen: false, artifactShareError: null }),

  /** The public/private switch for the open artifact's link. */
  setActiveArtifactShared: async (shared) => {
    const share = get().activeArtifactShare();
    if (!share) return;
    set({ artifactShareBusy: true, artifactShareError: null });
    try {
      const updated = await api.setArtifactShared(share.publicId, shared);
      set({ artifactShare: updated, artifactShareBusy: false });
    } catch (err) {
      set({ artifactShareBusy: false, artifactShareError: err.message });
    }
  },

  /**
   * Point-and-edit: rewrite ONE element of the open artifact. `start`/`end` are
   * offsets into `activeArtifact.code` (from lib/htmlNodes.js) and `snippet` is
   * the current text there; the server re-checks both before touching anything.
   * The edit lands as a normal message pair, so it survives reload and shows up
   * in the transcript. Returns { ok, error }.
   */
  editArtifactElement: async ({ start, end, snippet, instruction, targetLabel }) => {
    const { activeArtifact, currentId, selectedModelId } = get();
    if (!activeArtifact?.messageId || !currentId) {
      const error = 'This artifact was not saved yet — send a message first.';
      set({ artifactEditError: error });
      return { ok: false, error };
    }
    // A model edit takes seconds; the user can switch chats meanwhile. Remember
    // what this request was for so its result can't land in another transcript.
    const requestConvoId = currentId;
    const requestMessageId = activeArtifact.messageId;
    set({ artifactEditBusy: true, artifactEditError: null, artifactEditNote: null });
    try {
      const res = await api.editArtifact(requestConvoId, {
        messageId: requestMessageId,
        artifactIndex: activeArtifact.index ?? 0,
        start,
        end,
        snippet,
        instruction,
        targetLabel,
        modelId: selectedModelId,
      });
      if (get().currentId !== requestConvoId) {
        // Saved server-side; it'll be there when the user comes back to that chat.
        set({ artifactEditBusy: false });
        return { ok: false, error: 'You switched chats — the edit was saved in the original chat.' };
      }
      const artifacts = extractArtifacts(res.message.content, res.message._id);
      const stillSameArtifact = get().activeArtifact?.messageId === requestMessageId;
      const note = !artifacts.length
        ? null
        : res.unchanged
          ? 'The model returned the element unchanged — try a more specific instruction.'
          : res.tagSwapped
            ? 'Applied — note that the element type changed.'
            : null;
      set((s) => ({
        messages: [...s.messages, res.userMessage, res.message],
        conversations: s.conversations
          .map((c) => (c._id === requestConvoId ? res.conversation : c))
          .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)),
        // Only re-point the panel if it's still showing the artifact we edited.
        ...(artifacts.length && stillSameArtifact ? { activeArtifact: artifacts[0] } : {}),
        artifactEditBusy: false,
        artifactEditNote: note,
        // An edit that shrinks the artifact below the preview threshold can't be
        // shown — say so instead of leaving the panel silently one version behind.
        ...(artifacts.length
          ? {}
          : {
              artifactEditError:
                'The edit was saved but left too little markup to preview — the panel still shows the previous version.',
            }),
      }));
      return { ok: artifacts.length > 0, unchanged: res.unchanged };
    } catch (err) {
      if (get().currentId !== requestConvoId) {
        set({ artifactEditBusy: false });
        return { ok: false, error: err.message };
      }
      set({ artifactEditBusy: false, artifactEditError: err.message });
      return { ok: false, error: err.message };
    }
  },
  clearArtifactEditFeedback: () => set({ artifactEditError: null, artifactEditNote: null }),
  openAttachment: (att) => set({ activeAttachment: att }),
  closeAttachment: () => set({ activeAttachment: null }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
