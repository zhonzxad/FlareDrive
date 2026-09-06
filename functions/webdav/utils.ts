export interface RequestHandlerParams {
  bucket: R2Bucket;
  path: string;
  request: Request;
}

export const WEBDAV_ENDPOINT = "/webdav/";

export const ROOT_OBJECT = {
  key: "",
  uploaded: new Date(),
  httpMetadata: {
    contentType: "application/x-directory",
    contentDisposition: undefined,
    contentLanguage: undefined,
  },
  customMetadata: undefined,
  size: 0,
  etag: undefined,
  httpEtag: undefined,
};

export const DIRECTORY_CONTENT_TYPE = "application/x-directory";

export function notFound() {
  return new Response("Not found", { status: 404 });
}

export function parseBucketPath(
  context: any
): [R2Bucket | undefined, string] {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const pathSegments = (params.path || []) as String[];
  const path = decodeURIComponent(pathSegments.join("/"));
  const driveid = url.hostname.replace(/\..*/, "");

  // 只有真正拿到 R2Bucket 才算绑定成功；否则调用方会拿到 undefined
  // 并在每个操作上抛 TypeError，而不是给出一个明确的配置错误
  const candidate = env[driveid] ?? env["BUCKET"];
  const bucket =
    typeof candidate?.head === "function"
      ? (candidate as R2Bucket)
      : undefined;

  return [bucket, path];
}

export async function* listAll(
  bucket: R2Bucket,
  prefix?: string,
  isRecursive: boolean = false
) {
  let cursor: string | undefined = undefined;
  do {
    var r2Objects = await bucket.list({
      prefix: prefix,
      delimiter: isRecursive ? undefined : "/",
      cursor: cursor,
      // @ts-ignore
      include: ["httpMetadata", "customMetadata"],
    });

    for await (const obj of r2Objects.objects)
      if (!obj.key.startsWith("_$flaredrive$/")) yield obj;

    if (r2Objects.truncated) cursor = r2Objects.cursor;
  } while (r2Objects.truncated);
}
