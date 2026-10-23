"use client";
import { useRef, useState } from "react";
import AuthGuard from "./AuthGuard";
import AuthForm from "./AuthForm";
import Navbar from "./Navbar";
import { Alert, Box } from "@mui/material";
import { useAuth } from "../context/authContext";

export default function AuthPage({ page, authenticate }) {
  const { firebaseConfigured } = useAuth();
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit({ email, password }) {
    if (active.current) return;
    active.current = true;
    setPending(true); setError("");
    try { await authenticate(email.trim(), password); }
    catch (err) { setError(err.message || "Unable to authenticate. Please try again."); }
    finally { active.current = false; setPending(false); }
  }
  return (
    <AuthGuard guest>
      <Navbar page={page} />
      {firebaseConfigured
        ? <AuthForm page={page} onSubmit={submit} pending={pending} error={error} />
        : <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}><Alert severity="info">
          This demo is online. Sign-in and chat are unavailable until authentication is configured.
        </Alert></Box>}
    </AuthGuard>
  );
}
