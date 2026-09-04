"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError("Sign-in failed. Try again.");
      setPending(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold text-slate-50">Greyhound Relay</h1>
        <p className="mt-1 text-sm text-slate-400">Staff sign-in required</p>
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="rounded-full bg-white px-6 py-3 text-base font-semibold text-slate-900 disabled:opacity-60"
      >
        {pending ? "Opening Google…" : "Sign in with Google"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </main>
  );
}
