"use client";
import { useState } from "react";
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, List, ListItem, ListItemButton, ListItemText, Stack, TextField, Typography,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";

export default function ConversationSidebar({ conversations, selectedId, busy, onSelect, onCreate, onRename, onDelete }) {
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [title, setTitle] = useState("");

  async function rename(event) {
    event.preventDefault();
    if (await onRename(editing.id, title.trim())) setEditing(null);
  }

  return (
    <Box component="aside" aria-label="Conversations" sx={{
      width: { xs: "100%", sm: 280 }, flexShrink: 0, bgcolor: "#E3F2FD", p: 2,
      overflowY: "auto", maxHeight: { xs: "30vh", sm: "none" },
    }}>
      <Stack spacing={2}>
        <Typography variant="h6">Your conversations</Typography>
        <Button variant="contained" disabled={busy} onClick={onCreate}>New chat</Button>
        {!conversations.length && <Typography color="text.secondary">Start a chat to save your conversation.</Typography>}
        <List disablePadding>
          {conversations.map((conversation) => (
            <ListItem key={conversation.id} disablePadding sx={{ mb: 1, alignItems: "flex-start" }}>
              <Box sx={{ width: "100%" }}>
                <ListItemButton disabled={busy} selected={selectedId === conversation.id} onClick={() => onSelect(conversation.id)}>
                  <ListItemText primary={conversation.title} primaryTypographyProps={{ sx: { overflowWrap: "anywhere" } }} />
                </ListItemButton>
                <Stack direction="row" justifyContent="flex-end">
                  <IconButton size="small" disabled={busy} aria-label={`Rename ${conversation.title}`} onClick={() => {
                    setEditing(conversation); setTitle(conversation.title);
                  }}><EditIcon fontSize="small" /></IconButton>
                  <IconButton size="small" disabled={busy} aria-label={`Delete ${conversation.title}`} onClick={() => setDeleting(conversation)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Box>
            </ListItem>
          ))}
        </List>
      </Stack>
      <Dialog open={Boolean(editing)} onClose={() => !busy && setEditing(null)} fullWidth maxWidth="xs">
        <Box component="form" onSubmit={rename}>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogContent>
            <TextField autoFocus fullWidth label="Title" value={title} disabled={busy}
              inputProps={{ maxLength: 100 }} onChange={(event) => setTitle(event.target.value)} sx={{ mt: 1 }} />
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>Save</Button>
          </DialogActions>
        </Box>
      </Dialog>
      <Dialog open={Boolean(deleting)} onClose={() => !busy && setDeleting(null)}>
        <DialogTitle>Delete conversation?</DialogTitle>
        <DialogContent>This permanently deletes the conversation and its messages.</DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color="error" disabled={busy} onClick={async () => {
            if (await onDelete(deleting.id)) setDeleting(null);
          }}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
