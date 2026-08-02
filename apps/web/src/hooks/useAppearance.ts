import { useEffect, useState } from "react";

import { useShellStore } from "../store/useShellStore";

export type ResolvedTheme = "dark" | "light";

export function useResolvedTheme(): ResolvedTheme {
  const themeMode = useShellStore((state) => state.themeMode);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark",
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => setSystemTheme(media.matches ? "light" : "dark");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return themeMode === "system" ? systemTheme : themeMode;
}

export function useAppearance(): void {
  const themeMode = useShellStore((state) => state.themeMode);
  const textScale = useShellStore((state) => state.textScale);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme =
        themeMode === "system"
          ? media.matches
            ? "light"
            : "dark"
          : themeMode;
      document.documentElement.dataset.textScale = textScale;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [textScale, themeMode]);
}
