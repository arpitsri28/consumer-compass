"use client";
import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useAuth } from "../../context/authContext";
import { doSignOut } from "../../lib/auth";

export default function Logout() {
  const { loading } = useAuth();
  const router = useRouter();
  const attempt = useRef(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (loading) return;
    let active = true;
    if (!attempt.current) attempt.current = doSignOut();
    void attempt.current.then(() => {
      if (active) router.replace("/auth/login");
    }).catch(() => {
      if (active) setError("Unable to sign out. Please try again.");
    });
    return () => { active = false; };
  }, [loading, retry, router]);
  return <Box sx={{ p: 3 }}>{error
    ? <Alert severity="error" action={<Button onClick={() => { attempt.current = null; setError(""); setRetry((value) => value + 1); }}>Retry</Button>}>{error}</Alert>
    : <Typography role="status">Signing out…</Typography>}</Box>;
}
