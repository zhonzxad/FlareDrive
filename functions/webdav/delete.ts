import { notFound } from "./utils";
import { listAll, RequestHandlerParams, DIRECTORY_CONTENT_TYPE } from "./utils";

// R2 的 delete() 单次最多接受 1000 个 key
const DELETE_BATCH_SIZE = 1000;

async function deleteChildren(bucket: R2Bucket, path: string) {
  const prefix = path === "" ? undefined : `${path}/`;
  let batch: string[] = [];

  for await (const child of listAll(bucket, prefix, true)) {
    batch.push(child.key);
    if (batch.length >= DELETE_BATCH_SIZE) {
      await bucket.delete(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await bucket.delete(batch);
}

export async function handleRequestDelete({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  const depth = request.headers.get("Depth");
  if (depth !== null && depth !== "infinity")
    return new Response("Bad Request", { status: 400 });

  if (path !== "") {
    const obj = await bucket.head(path);
    if (obj === null) return notFound();
    await bucket.delete(path);
    if (obj.httpMetadata?.contentType !== DIRECTORY_CONTENT_TYPE)
      return new Response(null, { status: 204 });
  }

  await deleteChildren(bucket, path);

  return new Response(null, { status: 204 });
}
