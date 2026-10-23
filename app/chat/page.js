"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Stack, TextField, Button, Typography, Snackbar } from "@mui/material";
import { useAuth } from "../context/authContext";
import Navbar from "../components/Navbar";
import AuthGuard from "../components/AuthGuard";
import ConversationSidebar from "../components/ConversationSidebar";
import AssistantMarkdown from "../components/AssistantMarkdown";
import { chatRequest, resolveChatRetry } from "../lib/chat-client";

const welcome = "Welcome! You’ve reached the Ontario Consumer Rights Assistant. What can I help you with today?";

export default function Chat() {
  const { currentUser } = useAuth();
  return <AuthGuard><Navbar page="Chat" />
    {currentUser && <ChatWorkspace key={currentUser.uid} currentUser={currentUser} />}
  </AuthGuard>;
}

function ChatWorkspace({ currentUser }) {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [now, setNow] = useState(Date.now());
  const busyRef = useRef(false);
  const activeAction = useRef(null);
  const generation = useRef(null);
  const bottom = useRef(null);
  const request = useCallback((path, options = {}) => chatRequest(currentUser, path, {
    signal: activeAction.current?.signal, ...options,
  }), [currentUser]);

  useEffect(() => () => activeAction.current?.abort(), []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [messages]);
  useEffect(() => {
    if (!notice?.retryAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [notice?.retryAt]);

  useEffect(() => {
    const controller = new AbortController();
    setInitializing(true);
    void (async () => {
      try {
        const data = await (await request("/api/conversations", { signal: controller.signal })).json();
        if (controller.signal.aborted) return;
        setConversations(data.conversations);
        if (data.conversations.length) {
          const id = data.conversations[0].id;
          const history = await (await request(`/api/conversations/${id}`, { signal: controller.signal })).json();
          if (controller.signal.aborted) return;
          setSelectedId(id); setMessages(history.conversation.messages);
        }
      } catch (err) {
        if (!controller.signal.aborted) setNotice({ severity: "error", message: err.message,
          retry: () => { setNotice(null); setLoadVersion((value) => value + 1); } });
      } finally { if (!controller.signal.aborted) setInitializing(false); }
    })();
    return () => controller.abort();
  }, [request, loadVersion]);

  async function refreshList() {
    const data = await (await request("/api/conversations")).json();
    setConversations(data.conversations);
    return data.conversations;
  }
  async function loadTranscript(id) {
    const data = await (await request(`/api/conversations/${id}`)).json();
    setMessages(data.conversation.messages);
    return data.conversation.messages;
  }
  async function runAction(action, retry = action) {
    if (busyRef.current) return false;
    busyRef.current = true;
    const controller = new AbortController();
    activeAction.current = controller;
    setBusy(true); setNotice(null);
    try { await action(); return true; }
    catch (err) {
      if (!controller.signal.aborted) setNotice({ severity: "error", message: err.message,
        retry: () => runAction(retry, retry), retryAt: Date.now() + (err.retryAfter || 0) * 1000 });
      return false;
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) { setBusy(false); setGenerating(false); setStopping(false); }
      activeAction.current = null;
    }
  }
  async function createConversation() {
    const data = await (await request("/api/conversations", { method: "POST" })).json();
    setConversations((previous) => [data.conversation, ...previous]);
    setSelectedId(data.conversation.id); setMessages([]); setMessage("");
    return data.conversation.id;
  }
  const openConversation = (id) => runAction(async () => {
    await loadTranscript(id); setSelectedId(id); setMessage("");
  });
  const renameConversation = (id, title) => runAction(async () => {
    await request(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    await refreshList();
  });
  const deleteConversation = (id) => runAction(async () => {
    const existing = await refreshList();
    if (existing.some((entry) => entry.id === id)) await request(`/api/conversations/${id}`, { method: "DELETE" });
    if (selectedId === id) { setSelectedId(null); setMessages([]); setMessage(""); }
    await refreshList();
  });

  async function generateReply(attempt) {
    const controller = new AbortController();
    const operationSignal = activeAction.current.signal;
    const abort = () => controller.abort();
    operationSignal.addEventListener("abort", abort, { once: true });
    generation.current = controller;
    setGenerating(true); setStopping(false);
    const assistantId = attempt.body.retryMessageId || crypto.randomUUID();
    setMessages((previous) => attempt.body.retryMessageId
      ? previous.map((entry) => entry.id === assistantId ? { ...entry, content: "", incomplete: true } : entry)
      : [...previous, { id: crypto.randomUUID(), role: "user", content: attempt.body.message },
        { id: assistantId, role: "assistant", content: "", incomplete: true }]);
    let failure;
    try {
      const response = await request("/api/chat", {
        method: "POST", body: JSON.stringify(attempt.body), signal: controller.signal,
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          const text = decoder.decode(value, { stream: !done });
          if (text) setMessages((previous) => previous.map((entry) => entry.id === assistantId
            ? { ...entry, content: entry.content + text } : entry));
          if (done) break;
        }
      } finally { reader.releaseLock(); }
    } catch (err) {
      if (!controller.signal.aborted) { failure = err; attempt.status = err.status; }
    } finally {
      operationSignal.removeEventListener("abort", abort);
      generation.current = null;
      setGenerating(false);
    }
    if (operationSignal.aborted) return;
    // Stop aborts only generation; these fresh reads reconcile the persisted partial reply.
    try { await loadTranscript(attempt.body.conversationId); await refreshList(); }
    catch (err) { if (!failure) failure = err; }
    if (failure) {
      if ([400, 413].includes(failure.status) && attempt.body.message) setMessage(attempt.body.message);
      throw failure;
    }
    if (controller.signal.aborted) setNotice({ severity: "info", message: "Generation stopped. Reopen this conversation to refresh the saved partial reply." });
  }

  async function retryAttempt(attempt) {
    const transcript = await loadTranscript(attempt.body.conversationId);
    const decision = resolveChatRetry(attempt, transcript);
    if (decision.kind === "complete") { await refreshList(); return; }
    if (decision.kind === "review") {
      setMessage(attempt.body.message || "");
      setNotice({ severity: "info", message: "Conversation reloaded. Review the saved messages before sending again." });
      return;
    }
    attempt.body = decision.body;
    await generateReply(attempt);
  }
  function sendMessage() {
    if (!message.trim() || initializing) return;
    const content = message.trim();
    const attempt = { beforeIds: messages.map((entry) => entry.id) };
    return runAction(async () => {
      const id = selectedId || await createConversation();
      attempt.body = { conversationId: id, message: content };
      setMessage("");
      await generateReply(attempt);
    }, async () => {
      if (attempt.body) await retryAttempt(attempt);
      else { await refreshList(); setMessage(content); }
    });
  }

  const disabled = initializing || busy;
  const retrySeconds = Math.max(0, Math.ceil(((notice?.retryAt || 0) - now) / 1000));
  return (
    <Box sx={{ height: "93vh", display: "flex", flexDirection: { xs: "column", sm: "row" }, background: "linear-gradient(to right, #3a7bd5, #3a6073)" }}>
      <ConversationSidebar conversations={conversations} selectedId={selectedId} busy={disabled}
        onSelect={openConversation} onCreate={() => runAction(createConversation, refreshList)}
        onRename={renameConversation} onDelete={deleteConversation} />
      <Stack spacing={2} sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 2, bgcolor: "rgba(255,255,255,0.85)", backdropFilter: "blur(10px)" }}>
        <Stack spacing={2} sx={{ flex: 1, overflow: "auto" }} aria-live="polite" aria-busy={generating}>
          {!messages.length && <Typography sx={{ p: 2 }}>{initializing ? "Loading conversations…" : welcome}</Typography>}
          {messages.map((entry) => (
            <Box key={entry.id} display="flex" justifyContent={entry.role === "assistant" ? "flex-start" : "flex-end"}>
              <Box sx={{ bgcolor: entry.role === "assistant" ? "#E3F2FD" : "#C8E6C9", p: 2, borderRadius: 2, maxWidth: "80%", overflowWrap: "anywhere" }}>
                {entry.role === "assistant"
                  ? <AssistantMarkdown>{entry.content || (generating ? "Generating…" : "No reply was saved.")}</AssistantMarkdown>
                  : <Typography sx={{ whiteSpace: "pre-wrap" }}>{entry.content}</Typography>}
                {entry.incomplete && <Typography variant="caption" color="text.secondary">{generating ? "Reply in progress" : "Incomplete reply"}</Typography>}
              </Box>
            </Box>
          ))}
          <div ref={bottom} />
        </Stack>
        <Stack component="form" direction="row" spacing={2} onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
          <TextField label="Message" multiline minRows={1} maxRows={5} fullWidth disabled={disabled} value={message}
            onChange={(event) => setMessage(event.target.value)} sx={{ bgcolor: "#EEEEEE" }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); sendMessage();
              }
            }} />
          {generating
            ? <Button variant="outlined" disabled={stopping} onClick={() => { setStopping(true); generation.current?.abort(); }}>{stopping ? "Stopping…" : "Stop"}</Button>
            : <Button type="submit" variant="contained" disabled={disabled || !message.trim()}
              sx={{ bgcolor: "#C8E6C9", color: "#3E4E50", "&:hover": { bgcolor: "#A5D6A7" } }}>Send</Button>}
        </Stack>
      </Stack>
      <Snackbar open={Boolean(notice)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }} onClose={(_event, reason) => { if (reason !== "clickaway") setNotice(null); }}>
        <Alert severity={notice?.severity || "error"} onClose={() => setNotice(null)} sx={{ width: "100%" }}
          action={notice?.retry && <Button color="inherit" disabled={busy || initializing || retrySeconds > 0} onClick={notice.retry}>
            {retrySeconds ? `Retry in ${retrySeconds}s` : "Retry"}
          </Button>}>{notice?.message}</Alert>
      </Snackbar>
    </Box>
  );
}
