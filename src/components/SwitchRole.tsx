"use client";

import { useRouter } from "next/navigation";
import { setStoredRole, type Role } from "@/lib/role";

export function SwitchRole({ current }: { current: Role }) {
  const router = useRouter();
  const other: Role = current === "booth" ? "sideline" : "booth";

  return (
    <button
      type="button"
      onClick={() => {
        setStoredRole(other);
        router.push(`/${other}`);
      }}
      className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-300 active:bg-slate-800"
    >
      Switch to {other}
    </button>
  );
}
