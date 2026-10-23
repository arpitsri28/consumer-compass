"use client";
import AuthPage from "../../components/AuthPage";
import { doSignInWithEmailAndPassword } from "../../lib/auth";

export default function Login() {
  return <AuthPage page="Login" authenticate={doSignInWithEmailAndPassword} />;
}
