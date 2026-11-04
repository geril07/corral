const LIMIT = 8 * 1024 * 1024;

/** Native plugins may supply the catalog; a streaming response must obey the same size bound. */
export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty model response");
  if (Number(response.headers.get("content-length") ?? 0) > LIMIT) {
    await response.body.cancel();
    throw new Error("model response too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- bounded streaming read
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) throw new Error("model response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
