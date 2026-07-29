import { create } from 'zustand';
import { api, streamMessage } from '../api/client.js';
import { extractArtifacts } from '../lib/artifacts.js';

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
  activeAttachment: null, // { kind, dataUrl, name } — opens the lightbox viewer
  booted: false,
  bootError: null,

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
    } catch (err) {
      set({ bootError: err.message, booted: true });
    }
  },

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
  selectConversation: async (id) => {
    if (get().streaming) get().stopStreaming();
    set({ currentId: id, activeArtifact: null, messages: [], attachments: [], attachError: null });
    try {
      const convo = await api.getConversation(id);
      // Guard against a fast second click.
      if (get().currentId !== id) return;
      set({ messages: convo.messages, selectedModelId: convo.modelId });
    } catch (err) {
      set({ bootError: err.message });
    }
  },

  newChat: () => {
    if (get().streaming) get().stopStreaming();
    set({ currentId: null, messages: [], activeArtifact: null, attachments: [], attachError: null });
  },

  deleteConversation: async (id) => {
    await api.deleteConversation(id);
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
      const artifacts = extractArtifacts(message?.content || '');
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
  openArtifact: (artifact) => set({ activeArtifact: artifact }),
  closeArtifact: () => set({ activeArtifact: null }),
  openAttachment: (att) => set({ activeAttachment: att }),
  closeAttachment: () => set({ activeAttachment: null }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
