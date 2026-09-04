"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredRole, setStoredRole, type Role } from "@/lib/role";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const role = getStoredRole();
    if (role) router.replace(`/${role}`);
  }, [router]);

  function choose(role: Role) {
    setStoredRole(role);
    router.push(`/${role}`);
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold text-slate-50">Greyhound Relay</h1>
        <p className="mt-1 text-sm text-slate-400">Which side are you on today?</p>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-4">
        <button
          type="button"
          onClick={() => choose("booth")}
          className="rounded-2xl bg-emerald-600 px-6 py-8 text-2xl font-bold text-white active:bg-emerald-700"
        >
          Booth
          <span className="mt-1 block text-sm font-normal text-emerald-100">
            Tap presnap reads
          </span>
        </button>
        <button
          type="button"
          onClick={() => choose("sideline")}
          className="rounded-2xl bg-sky-600 px-6 py-8 text-2xl font-bold text-white active:bg-sky-700"
        >
          Sideline
          <span className="mt-1 block text-sm font-normal text-sky-100">
            Watch presnap reads
          </span>
        </button>
      </div>
    </main>
  );
}
