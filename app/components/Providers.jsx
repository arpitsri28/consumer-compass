"use client";
import { AuthProvider } from "../context/authContext";

export default function Providers({ children }) {
  return <AuthProvider>{children}</AuthProvider>;
}
