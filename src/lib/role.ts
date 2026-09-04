export type Role = "booth" | "sideline";

const STORAGE_KEY = "greyhound-relay-role";

export function getStoredRole(): Role | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "booth" || value === "sideline" ? value : null;
}

export function setStoredRole(role: Role) {
  window.localStorage.setItem(STORAGE_KEY, role);
}

export function clearStoredRole() {
  window.localStorage.removeItem(STORAGE_KEY);
}
