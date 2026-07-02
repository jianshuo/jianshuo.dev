// Tiny R2 helpers — the paginated list-everything loop used to be copied
// (do { list; cursor = truncated ? cursor : null } while) at every call site.

// All objects under a prefix (prefix undefined → the whole bucket).
export async function listAll(bucket, prefix, { limit } = {}) {
  const out = [];
  let cursor;
  do {
    const l = await bucket.list({ ...(prefix ? { prefix } : {}), ...(limit ? { limit } : {}), cursor });
    out.push(...l.objects);
    cursor = l.truncated ? l.cursor : null;
  } while (cursor);
  return out;
}

// Delete every object under each prefix. Best-effort by design.
export async function deleteAll(bucket, prefixes) {
  for (const prefix of prefixes) {
    for (const o of await listAll(bucket, prefix)) await bucket.delete(o.key);
  }
}
