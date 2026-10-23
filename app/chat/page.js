"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Stack, TextField, Button, Typography } from "@mui/material";
import { useAuth } from "../context/authContext";
import { useRouter } from "next/navigation";
import Navbar from "../components/Navbar";
import ConversationSidebar from "../components/ConversationSidebar";
import { chatRequest } from "../lib/chat-client";

const welcome = "Welcome! You’ve reached the Ontario Consumer Rights Assistant. What can I help you with today?";

export default function Chat() {
  const { userLoggedIn, currentUser, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !userLoggedIn) router.replace("/auth/login");
  }, [loading, userLoggedIn, router]);
  return (
    <Box>
      <Navbar page="Chat" />
      {!loading && currentUser
        ? <ChatWorkspace key={currentUser.uid} currentUser={currentUser} />
        : <Typography sx={{ p: 2 }}>Loading…</Typography>}
    </Box>
  );
}

function ChatWorkspace({ currentUser }) {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const busyRef = useRef(false);
  const activeAction = useRef(null);
  const request = useCallback((path, options = {}) => chatRequest(currentUser, path, {
    signal: activeAction.current?.signal, ...options,
  }), [currentUser]);

  useEffect(() => () => activeAction.current?.abort(), []);

  useEffect(() => {
    if (!currentUser) {
      setConversations([]); setSelectedId(null); setMessages([]);
      return;
    }
    const controller = new AbortController();
    setInitializing(true);
    setError("");
    void (async () => {
      try {
        const response = await request("/api/conversations", { signal: controller.signal });
        const data = await response.json();
        if (controller.signal.aborted) return;
        setConversations(data.conversations);
        if (data.conversations.length) {
          const id = data.conversations[0].id;
          const history = await (await request(`/api/conversations/${id}`, { signal: controller.signal })).json();
          if (controller.signal.aborted) return;
          setSelectedId(id); setMessages(history.conversation.messages);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setInitializing(false);
      }
    })();
    return () => controller.abort();
  }, [currentUser, request]);

  async function refreshList() {
    const data = await (await request("/api/conversations")).json();
    setConversations(data.conversations);
  }

  async function runAction(action) {
    if (busyRef.current) return false;
    busyRef.current = true;
    const controller = new AbortController();
    activeAction.current = controller;
    setBusy(true); setError("");
    try { await action(); return true; }
    catch (err) {
      if (!controller.signal.aborted) setError(err.message);
      return false;
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) setBusy(false);
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
    const data = await (await request(`/api/conversations/${id}`)).json();
    setSelectedId(id); setMessages(data.conversation.messages); setMessage("");
  });
  const renameConversation = (id, title) => runAction(async () => {
    await request(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    await refreshList();
  });
  const deleteConversation = (id) => runAction(async () => {
    await request(`/api/conversations/${id}`, { method: "DELETE" });
    if (selectedId === id) { setSelectedId(null); setMessages([]); setMessage(""); }
    await refreshList();
  });

  function sendMessage() {
    if (!message.trim()) return;
    return runAction(async () => {
      const content = message.trim();
      const id = selectedId || await createConversation();
      const assistantId = crypto.randomUUID();
      setMessage("");
      setMessages((previous) => [...previous,
        { id: crypto.randomUUID(), role: "user", content },
        { id: assistantId, role: "assistant", content: "", incomplete: true },
      ]);
      try {
        const response = await request("/api/chat", {
          method: "POST", body: JSON.stringify({ conversationId: id, message: content }),
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
      } finally {
        // Reload authoritative rows, including partial replies and their incomplete status.
        if (!activeAction.current?.signal.aborted) {
          const data = await (await request(`/api/conversations/${id}`)).json();
          setMessages(data.conversation.messages);
          await refreshList();
        }
      }
    });
  }

  const disabled = initializing || busy;
  return (
      <Box sx={{ height: "93vh", display: "flex", flexDirection: { xs: "column", sm: "row" }, background: "linear-gradient(to right, #3a7bd5, #3a6073)" }}>
        <ConversationSidebar conversations={conversations} selectedId={selectedId} busy={disabled}
          onSelect={openConversation} onCreate={() => runAction(createConversation)}
          onRename={renameConversation} onDelete={deleteConversation} />
        <Stack spacing={2} sx={{ flex: 1, minWidth: 0, minHeight: 0, p: 2, bgcolor: "rgba(255,255,255,0.85)", backdropFilter: "blur(10px)" }}>
          {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
          <Stack spacing={2} sx={{ flex: 1, overflow: "auto" }}>
            {!messages.length && <Typography sx={{ p: 2 }}>{initializing ? "Loading conversations…" : welcome}</Typography>}
            {messages.map((entry) => (
              <Box key={entry.id} display="flex" justifyContent={entry.role === "assistant" ? "flex-start" : "flex-end"}>
                <Box sx={{ bgcolor: entry.role === "assistant" ? "#E3F2FD" : "#C8E6C9", p: 2, borderRadius: 2, maxWidth: "80%", overflowWrap: "anywhere" }}>
                  <Typography sx={{ whiteSpace: "pre-wrap" }}>{entry.content || (busy ? "Generating…" : "No reply was saved.")}</Typography>
                  {entry.incomplete && <Typography variant="caption" color="text.secondary">{busy ? "Reply in progress" : "Incomplete reply"}</Typography>}
                </Box>
              </Box>
            ))}
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Message" fullWidth disabled={disabled} value={message} onChange={(event) => setMessage(event.target.value)} sx={{ bgcolor: "#EEEEEE" }} />
            <Button variant="contained" disabled={disabled || !message.trim()} onClick={sendMessage}
              sx={{ bgcolor: "#C8E6C9", color: "#3E4E50", "&:hover": { bgcolor: "#A5D6A7" } }}>Send</Button>
          </Stack>
        </Stack>
      </Box>
  );
}
