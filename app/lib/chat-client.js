export async function chatRequest(user, path, options = {}) {
  if (!user) throw new Error("Please sign in to continue.");
  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || "The request failed. Please try again.");
  }
  return response;
}
