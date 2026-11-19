/** Media must be served from the exact verified bytes, not a later filesystem fetch. */
export function verifiedMediaResponse(method: string, id: string, read?: (id: string) => Uint8Array | null): Response {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const bytes = method === "GET" ? read?.(id) : null;
    return bytes ? new Response(Uint8Array.from(bytes), { headers: { ...headers, "Content-Type": "image/png" } })
      : new Response("Not found", { status: 404, headers });
  } catch { return new Response("Not found", { status: 404, headers }); }
}
