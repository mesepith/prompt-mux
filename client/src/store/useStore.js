import { create } from 'zustand';
import { api, streamMessage } from '../api/client.js';
import { extractArtifacts } from '../lib/artifacts.js';
import { currentRouteId, navigateTo } from '../lib/router.js';

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
  activeAttachment: null, // { kind, dataUrl, name } — opens the lightbox viewer
  booted: false,
  bootError: null,
  linkError: null, // a shared/bookmarked /c/<id> link that no longer resolves

  // ---------- helpers ----------
  modelById: (id) => get().models.find((m) => m.id === id),
  companyById: (id) => get().companies.find((c) => c.id === id),
  companyForModel: (modelId) => {
    const model = get().modelById(modelId);
    return model ? get().companyById(model.company) : null;
  },

  // ---------- bootstrap ----------
  bootstrap: async () => {
    try {
      const [{ companies, models }, conversations] = await Promise.all([
        api.models(),
        api.listConversations(),
      ]);
      const firstAvailable = models.find(
        (m) => companies.find((c) => c.id === m.company)?.available
      );
      set({
        companies,
        models,
        conversations,
        selectedModelId: firstAvailable?.id || 'demo-artist',
        booted: true,
      });
      // Deep link: /c/<id> opens that chat straight away (bookmark / shared link).
      const routeId = currentRouteId();
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

  // ---------- attachments (composer + drop zone) ----------
  addAttachments: (files) => {
    const MAX_IMAGES = 4;
    const MAX_PDFS = 2;
    const MAX_DOCS = 2;
    const MAX_IMAGE_MB = 5;
    const MAX_PDF_MB = 8;
    const MAX_DOC_MB = 8;
    set({ attachError: null });
    let imgRoom = MAX_IMAGES - get().attachments.filter((a) => a.kind === 'image').length;
    let pdfRoom = MAX_PDFS - get().attachments.filter((a) => a.kind === 'pdf').length;
    let docRoom = MAX_DOCS - get().attachments.filter((a) => a.kind === 'doc').length;
    const fail = (msg) => set({ attachError: msg });

    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(file.name);
      const isDoc = file.type === 'application/msword' || /\.doc$/i.test(file.name);
      const isImage = file.type.startsWith('image/');
      if (!isPdf && !isDocx && !isDoc && !isImage) {
        fail('Only images, PDFs and Word docs (.doc/.docx) are supported');
        continue;
      }
      if (isDocx || isDoc) {
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
      const kind = isDocx || isDoc ? 'doc' : isPdf ? 'pdf' : 'image';
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
    });
    try {
      const convo = await api.getConversation(id);
      // Guard against a fast second click.
      if (get().currentId !== id) return;
      const { messages, ...meta } = convo;
      set((s) => ({
        messages,
        selectedModelId: convo.modelId,
        // A link opened in another tab/window may point at a chat this list
        // hasn't seen yet — fold it in so the sidebar and title bar match.
        conversations: s.conversations.some((c) => c._id === id)
          ? s.conversations
          : [meta, ...s.conversations],
      }));
    } catch (err) {
      if (get().currentId !== id) return;
      set({ currentId: null, messages: [], linkError: `Can't open that chat link — ${err.message}` });
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
    const { currentId, conversations } = get();
    if (!currentId) return;
    const convo = await api.updateConversation(currentId, { modelId });
    set({
      conversations: conversations.map((c) => (c._id === currentId ? convo : c)),
    });
  },

  // Vision model used ONLY to describe images when the chat model can't see them.
  // Works before the conversation exists: the draft is persisted on first send.
  setVisionModel: async (visionModelId) => {
    set({ selectedVisionModelId: visionModelId });
    const { currentId, conversations } = get();
    if (!currentId) return;
    const convo = await api.updateConversation(currentId, { visionModelId });
    set({
      conversations: conversations.map((c) => (c._id === currentId ? convo : c)),
    });
  },

  // ---------- sending ----------
  sendMessage: async (content) => {
    const text = content.trim();
    const { streaming, selectedModelId, attachments } = get();
    if ((!text && !attachments.length) || streaming) return;

    let { currentId } = get();

    // First message of a brand-new chat: create the conversation on the fly.
    if (!currentId) {
      const convo = await api.createConversation(
        selectedModelId,
        get().selectedVisionModelId || undefined
      );
      currentId = convo._id;
      set((s) => ({ currentId, conversations: [convo, ...s.conversations], messages: [] }));
      // The chat now has a permanent link — swap `/` for it (replace, not push,
      // so Back leaves the app instead of returning to an empty new chat).
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
          } else if (ev.type === 'done') {
            finish(ev.message);
          } else if (ev.type === 'error') {
            finish(ev.message);
          }
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return; // server already saved partial state
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
  closeArtifact: () => set({ activeArtifact: null, artifactEditError: null, artifactEditNote: null }),

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
