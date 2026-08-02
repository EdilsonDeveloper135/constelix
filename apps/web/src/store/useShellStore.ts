import { create } from "zustand";

export type ThemeMode = "dark" | "light" | "system";
export type TextScale = "default" | "large";

interface ShellState {
  onboardingOpen: boolean;
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  themeMode: ThemeMode;
  textScale: TextScale;
  setOnboardingOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setTextScale: (textScale: TextScale) => void;
}

function storedAppearance<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

function persistAppearance(key: string, value: string): void {
  if (typeof window !== "undefined") window.localStorage.setItem(key, value);
}

export const useShellStore = create<ShellState>((set) => ({
  onboardingOpen: true,
  commandPaletteOpen: false,
  settingsOpen: false,
  helpOpen: false,
  themeMode: storedAppearance(
    "constelix:theme",
    ["dark", "light", "system"] as const,
    "dark",
  ),
  textScale: storedAppearance(
    "constelix:text-scale",
    ["default", "large"] as const,
    "default",
  ),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setCommandPaletteOpen: (commandPaletteOpen) =>
    set({ commandPaletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setThemeMode: (themeMode) => {
    persistAppearance("constelix:theme", themeMode);
    set({ themeMode });
  },
  setTextScale: (textScale) => {
    persistAppearance("constelix:text-scale", textScale);
    set({ textScale });
  },
}));
