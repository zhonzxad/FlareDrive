import { RequestHandlerParams, ROOT_OBJECT, DIRECTORY_CONTENT_TYPE } from "./utils";

export async function handleRequestMkcol({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  // Validate path
  if (path === "" || path.endsWith("/")) {
    return new Response("Bad Request: empty or trailing slash path", { status: 400 });
  }
  
  // Validate key length (R2 limit: 1024 bytes)
  if (new TextEncoder().encode(path).length > 1024) {
    return new Response("Bad Request: key exceeds 1024 bytes", { status: 400 });
  }

  // Check if the resource already exists
  const resource = await bucket.head(path);
  if (resource !== null) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Check if the parent directory exists and is a directory
  const parentPath = path.replace(/(\/|^)[^/]*$/, "");
  if (parentPath !== "") {
    const parentDir = await bucket.head(parentPath);
    if (parentDir === null) {
      return new Response("Conflict", { status: 409 });
    }
    // Parent must be a directory
    if (parentDir.httpMetadata?.contentType !== DIRECTORY_CONTENT_TYPE) {
      return new Response("Conflict: parent is not a directory", { status: 409 });
    }
  }

  await bucket.put(path, "", {
    httpMetadata: { contentType: DIRECTORY_CONTENT_TYPE },
  });

  return new Response("Created", { status: 201 });
}
