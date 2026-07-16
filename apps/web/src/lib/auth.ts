let cachedToken: string | null | undefined;

export function readCapabilityToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  const rawFragment = window.location.hash.slice(1);
  if (!rawFragment) {
    cachedToken = null;
    return cachedToken;
  }

  const params = new URLSearchParams(rawFragment);
  cachedToken = params.get("token") ?? params.get("access_token");

  if (!cachedToken && !rawFragment.includes("=")) {
    cachedToken = decodeURIComponent(rawFragment);
  }

  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return cachedToken;
}

export function resetCapabilityTokenForTests(): void {
  cachedToken = undefined;
}
