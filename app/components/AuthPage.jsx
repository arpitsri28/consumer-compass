"use client";
import { useRef, useState } from "react";
import AuthGuard from "./AuthGuard";
import AuthForm from "./AuthForm";
import Navbar from "./Navbar";

export default function AuthPage({ page, authenticate }) {
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
      <AuthForm page={page} onSubmit={submit} pending={pending} error={error} />
    </AuthGuard>
  );
}
