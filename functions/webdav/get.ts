import { notFound } from "./utils";
import { RequestHandlerParams } from "./utils";

type ByteRange = { start: number; end: number };

/**
 * 解析 `Range: bytes=...`（RFC 7233）。只支持单个区间，
 * 多区间或不合法写法一律返回 null，由调用方回退到完整响应 / 416。
 */
function parseRangeHeader(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (size === 0 || start >= size || start > end) return null;
  return { start, end };
}

export async function handleRequestGet({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  const rangeHeader = request.headers.get("Range");
  let range: ByteRange | null = null;
  let totalSize: number | null = null;

  if (rangeHeader !== null) {
    // 只有拿到对象真实大小才能算出合法的 Content-Range，
    // R2Object.size 在区间读取时的语义不保证是完整大小，所以显式 head 一次。
    const head = await bucket.head(path);
    if (head === null) return notFound();
    totalSize = head.size;

    range = parseRangeHeader(rangeHeader, head.size);
    if (range === null)
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${head.size}`,
          "Accept-Ranges": "bytes",
        },
      });
  }

  const obj = await bucket.get(path, {
    onlyIf: request.headers,
    range: range
      ? { offset: range.start, length: range.end - range.start + 1 }
      : undefined,
  });
  if (obj === null) return notFound();
  if (!("body" in obj))
    return new Response("Preconditions failed", { status: 412 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (path.startsWith("_$flaredrive$/thumbnails/"))
    headers.set("Cache-Control", "max-age=31536000");
  headers.set("Accept-Ranges", "bytes");

  if (range !== null && totalSize !== null) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
