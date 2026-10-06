type SessionStorageAccess = () => Pick<Storage, "getItem" | "setItem">;

export function readSessionPreference(
  key: string,
  getStorage: SessionStorageAccess = () => window.sessionStorage,
): string | null {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
}

export function writeSessionPreference(
  key: string,
  value: string,
  getStorage: SessionStorageAccess = () => window.sessionStorage,
): void {
  try {
    getStorage().setItem(key, value);
  } catch {
    // Navigation remains usable with in-memory state when session storage is unavailable.
  }
}
