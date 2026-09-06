import { RequestHandlerParams, ROOT_OBJECT } from "./utils";

async function handleRequestPutMultipart({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  const url = new URL(request.url);

  const uploadId = new URLSearchParams(url.search).get("uploadId");
  const partNumberStr = new URLSearchParams(url.search).get("partNumber");
  if (!uploadId || !partNumberStr || !request.body)
    return new Response("Bad Request", { status: 400 });
  const multipartUpload = bucket.resumeMultipartUpload(path, uploadId);

  const partNumber = parseInt(partNumberStr);
  try {
    const uploadedPart = await multipartUpload.uploadPart(
      partNumber,
      request.body
    );

    return new Response(null, {
      headers: { "Content-Type": "application/json", etag: uploadedPart.etag },
    });
  } catch (error) {
    // Abort the multipart upload on failure to prevent billing for incomplete parts
    try {
      await multipartUpload.abort();
    } catch {
      // Ignore abort errors
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Upload part failed: ${message}`, { status: 500 });
  }
}

export async function handleRequestPut({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  const searchParams = new URLSearchParams(new URL(request.url).search);
  if (searchParams.has("uploadId")) {
    return handleRequestPutMultipart({ bucket, path, request });
  }

  // Validate path
  if (path === "" || path.endsWith("/")) {
    return new Response("Bad Request: empty or trailing slash path", { status: 400 });
  }
  
  // Validate key length (R2 limit: 1024 bytes)
  if (new TextEncoder().encode(path).length > 1024) {
    return new Response("Bad Request: key exceeds 1024 bytes", { status: 400 });
  }

  // Check if the parent directory exists
  // Allow _$flaredrive$/ prefix for internal thumbnails
  if (!path.startsWith("_$flaredrive$/")) {
    const parentPath = path.replace(/(\/|^)[^/]*$/, "");
    const parentDir =
      parentPath === "" ? ROOT_OBJECT : await bucket.head(parentPath);
    if (parentDir === null) return new Response("Conflict", { status: 409 });
  }

  const thumbnail = request.headers.get("fd-thumbnail");
  const customMetadata = thumbnail ? { thumbnail } : undefined;

  const result = await bucket.put(path, request.body, {
    onlyIf: request.headers,
    httpMetadata: request.headers,
    customMetadata,
  });

  if (!result) return new Response("Preconditions failed", { status: 412 });

  return new Response("", { status: 201 });
}
