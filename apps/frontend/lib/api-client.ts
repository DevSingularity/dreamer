import { API_BASE_URL } from "./config";

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

async function refreshAccessToken(): Promise<string | null> {
  const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    credentials: 'include', // sends the httpOnly refreshToken cookie
  });

  if (!res.ok) {
    setAccessToken(null);
    return null;
  }

  const data = await res.json();
  setAccessToken(data.accessToken);
  return data.accessToken;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string | null) =>
    fetch(`${API_BASE_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: { ...options.headers, Authorization: token ? `Bearer ${token}` : '' },
    });

  let res = await doFetch(accessToken);

  if (res.status === 401 && (await res.json().catch(() => null))?.code === 'TOKEN_EXPIRED') {
    // Coalesce concurrent refreshes — if five requests 401 at once, only one
    // network call to /refresh happens; the other four await the same promise.
    refreshPromise ??= refreshAccessToken().finally(() => {
      refreshPromise = null;
    });

    const newToken = await refreshPromise;
    if (newToken) res = await doFetch(newToken);
  }

  return res;
}