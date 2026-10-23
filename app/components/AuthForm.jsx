"use client";
import { useState } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import Link from "next/link";

export default function AuthForm({ page, onSubmit, pending, error }) {
  const [user, setUser] = useState({ email: "", password: "" });
  const register = page === "Register";
  const handleChange = ({ target: { name, value } }) => setUser((previous) => ({ ...previous, [name]: value }));
  return (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "80vh", width: "100%", p: 2 }}>
      <Stack component="form" onSubmit={(event) => { event.preventDefault(); if (!pending) onSubmit(user); }}
        spacing={3} sx={{ width: "100%", maxWidth: 500, p: 3, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
        <Typography variant="h5">{page}</Typography>
        <TextField id="email" label="Email" name="email" type="email" autoComplete="email" required
          disabled={pending} value={user.email} onChange={handleChange} fullWidth />
        <TextField id="password" label="Password" name="password" type="password" required
          autoComplete={register ? "new-password" : "current-password"} inputProps={{ minLength: register ? 6 : 1 }}
          disabled={pending} value={user.password} onChange={handleChange} fullWidth />
        {error && <Alert severity="error">{error}</Alert>}
        <Button variant="contained" type="submit" disabled={pending}>
          {pending ? (register ? "Registering…" : "Signing in…") : page}
        </Button>
        <Typography>
          {register ? "Already have an account? " : "Don't have an account? "}
          <Link href={register ? "/auth/login" : "/auth/register"}>{register ? "Sign in" : "Sign up"}</Link>
        </Typography>
      </Stack>
    </Box>
  );
}
