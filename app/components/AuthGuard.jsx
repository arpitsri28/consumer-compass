"use client";
import { useEffect } from "react";
import { Box, CircularProgress } from "@mui/material";
import { useRouter } from "next/navigation";
import { useAuth } from "../context/authContext";

export default function AuthGuard({ children, guest = false }) {
  const { userLoggedIn, loading } = useAuth();
  const router = useRouter();
  const redirect = loading ? null : guest
    ? (userLoggedIn ? "/chat" : null)
    : (userLoggedIn ? null : "/auth/login");
  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);
  if (loading || redirect) {
    return <Box role="status" aria-label="Loading account" sx={{ display: "flex", justifyContent: "center", p: 4 }}><CircularProgress /></Box>;
  }
  return children;
}
