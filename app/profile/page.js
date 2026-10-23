"use client";
import { Box, Typography } from "@mui/material";
import { useAuth } from "../context/authContext";
import AuthGuard from "../components/AuthGuard";
import Navbar from "../components/Navbar";

export default function Profile() {
  const { currentUser } = useAuth();
  return (
    <AuthGuard>
      <Navbar page="Profile" />
      <Box sx={{ minHeight: "80vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Typography variant="h4">Profile</Typography>
        <Typography>Email: {currentUser?.email}</Typography>
      </Box>
    </AuthGuard>
  );
}
