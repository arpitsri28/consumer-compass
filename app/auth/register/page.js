"use client";
import AuthPage from "../../components/AuthPage";
import { doCreateUserWithEmailAndPassword } from "../../lib/auth";

export default function Register() {
  return <AuthPage page="Register" authenticate={doCreateUserWithEmailAndPassword} />;
}
