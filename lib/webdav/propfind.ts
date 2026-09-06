import {
  listAll,
  listDirectories,
  RequestHandlerParams,
  ROOT_OBJECT,
  WEBDAV_ENDPOINT,
  DIRECTORY_CONTENT_TYPE,
} from "./utils";

type DirectoryEntry = {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata: {
    contentType: string;
    contentLanguage?: undefined;
    contentDisposition?: undefined;
  };
  customMetadata: undefined;
  etag: undefined;
  httpEtag: undefined;
};

type ListedObject = R2Object | typeof ROOT_OBJECT | DirectoryEntry;

function syntheticDirectory(key: string): DirectoryEntry {
  return {
    key,
    size: 0,
    uploaded: new Date(),
    httpMetadata: { contentType: DIRECTORY_CONTENT_TYPE },
    customMetadata: undefined,
    etag: undefined,
    httpEtag: undefined,
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isDirectory(object: ListedObject): boolean {
  return (
    object === ROOT_OBJECT ||
    object.httpMetadata?.contentType === DIRECTORY_CONTENT_TYPE
  );
}

function buildHref(key: string, directory: boolean): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  const href = `${WEBDAV_ENDPOINT}${encoded}`;
  return xmlEscape(directory && !href.endsWith("/") ? `${href}/` : href);
}

function displayName(key: string): string {
  return key.split("/").filter((segment) => segment !== "").pop() ?? "";
}

function isoDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function renderResponse(object: ListedObject): string {
  const directory = isDirectory(object);
  const properties: string[] = [];

  const push = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    properties.push(`        <${name}>${xmlEscape(value)}</${name}>`);
  };

  push("creationdate", isoDate(object.uploaded));
  push("displayname", displayName(object.key));
  push("getcontentlanguage", object.httpMetadata?.contentLanguage);
  push("getcontentlength", String(object.size));
  push("getcontenttype", object.httpMetadata?.contentType);
  push("getetag", object.httpEtag ?? object.etag);
  push("getlastmodified", object.uploaded.toUTCString());
  properties.push(
    `        <resourcetype>${directory ? "<collection />" : ""}</resourcetype>`
  );
  push("fd:thumbnail", object.customMetadata?.thumbnail);

  return `
  <response>
    <href>${buildHref(object.key, directory)}</href>
    <propstat>
      <prop>
${properties.join("\n")}
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>`;
}

// 限制单次 PROPFIND 的对象数，避免在大目录上拼出巨型 XML 把隔离内存耗尽，
// 也避免 Depth: infinity 在中等规模桶上耗光子请求/CPU 配额
const PROPFIND_LIMIT_DEPTH_1 = 1000;
const PROPFIND_LIMIT_DEPTH_INFINITY = 500;

async function findChildren({
  bucket,
  path,
  isRecursive,
}: {
  bucket: R2Bucket;
  path: string;
  isRecursive: boolean;
}) {
  const objects: Array<R2Object> = [];

  const prefix = path === "" ? path : `${path}/`;
  const limit = isRecursive
    ? PROPFIND_LIMIT_DEPTH_INFINITY
    : PROPFIND_LIMIT_DEPTH_1;
  for await (const object of listAll(bucket, prefix, isRecursive, limit)) {
    objects.push(object);
  }

  if (isRecursive) return objects;

  // 没有占位对象的目录只能通过公共前缀看到，listAll 不会遍历它们
  const objectKeys = new Set(objects.map((object) => object.key));
  const directories: DirectoryEntry[] = [];
  for await (const commonPrefix of listDirectories(
    bucket,
    prefix === "" ? undefined : prefix
  )) {
    if (objectKeys.has(commonPrefix.replace(/\/$/, ""))) continue;
    if (objects.length + directories.length >= limit) break;
    directories.push(syntheticDirectory(commonPrefix.replace(/\/$/, "")));
  }
  return [...objects, ...directories];
}

export async function handleRequestPropfind({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  const depth = request.headers.get("Depth") ?? "infinity";
  if (!["0", "1", "infinity"].includes(depth))
    return new Response("Bad Request", { status: 400 });

  const rootObject = path === "" ? ROOT_OBJECT : await bucket.head(path);
  if (!rootObject) return new Response("Not found", { status: 404 });

  const children = !isDirectory(rootObject)
    ? []
    : await findChildren({
        bucket,
        path,
        isRecursive: depth === "infinity",
      });

  const items = [rootObject, ...children].map(renderResponse).join("");

  return new Response(
    `<?xml version="1.0" encoding="utf-8" ?>
<multistatus xmlns="DAV:" xmlns:fd="flaredrive">${items}
</multistatus>`,
    {
      status: 207,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    }
  );
}
