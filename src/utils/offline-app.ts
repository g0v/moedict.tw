/**
 * True inside the Capacitor shell and inside moedict-app's Vite build
 * (`VITE_MOEDICT_OFFLINE_APP=1`), which packages dictionary data locally
 * and does not proxy `/assets/*` to the Worker.
 */
export function isOfflineApp(): boolean {
  if (import.meta.env.VITE_MOEDICT_OFFLINE_APP === "1") return true;
  return (
    typeof window !== "undefined" && Boolean((window as Window & { Capacitor?: unknown }).Capacitor)
  );
}
