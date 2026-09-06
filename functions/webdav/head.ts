import { notFound } from "./utils";
import { RequestHandlerParams } from "./utils";

export async function handleRequestHead({
  bucket,
  path,
}: RequestHandlerParams) {
  const obj = await bucket.head(path);
  if (obj === null) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // writeHttpMetadata 只写 contentType / contentLanguage / contentDisposition /
  // cacheControl / cacheExpiry；其它缓存相关头需要补齐，否则 curl /
  // WebDAV 客户端会认为资源"未知大小"。
  headers.set("etag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(obj.size));
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  return new Response(null, { headers });
}