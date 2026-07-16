export function nextHorizontalTabIndex(
  currentIndex: number,
  key: string,
  tabCount: number,
): number | null {
  if (tabCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  const normalizedIndex =
    currentIndex >= 0 && currentIndex < tabCount ? currentIndex : 0;
  const direction = key === "ArrowRight" ? 1 : -1;
  return (normalizedIndex + direction + tabCount) % tabCount;
}
