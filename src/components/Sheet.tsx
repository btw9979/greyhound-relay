"use client";

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/60">
      <div className="w-full rounded-t-3xl bg-slate-900 p-5 pb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-50">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300 active:bg-slate-700"
          >
            Cancel
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
