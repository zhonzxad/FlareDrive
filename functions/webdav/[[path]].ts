import { parseBucketPath } from "../../lib/webdav/utils";
import { RequestHandlerParams } from "../../lib/webdav/utils";
import { handleRequestCopy } from "../../lib/webdav/copy";
import { handleRequestDelete } from "../../lib/webdav/delete";
import { handleRequestGet } from "../../lib/webdav/get";
import { handleRequestHead } from "../../lib/webdav/head";
import { handleRequestMkcol } from "../../lib/webdav/mkcol";
import { handleRequestMove } from "../../lib/webdav/move";
import { handleRequestPropfind } from "../../lib/webdav/propfind";
import { handleRequestPut } from "../../lib/webdav/put";
import { handleRequestPost, handleRequestPostAbortMultipart } from "../../lib/webdav/post";

const WWW_AUTHENTICATE = `Basic realm="WebDAV", charset="UTF-8"`;

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": WWW_AUTHENTICATE },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function handleRequestOptions() {
  return new Response(null, {
    headers: {
      Allow: Object.keys(HANDLERS).join(", "),
      DAV: "1",
    },
  });
}

async function handleMethodNotAllowed() {
  return new Response(null, { status: 405 });
}

const HANDLERS: Record<
  string,
  (context: RequestHandlerParams) => Promise<Response>
> = {
  PROPFIND: handleRequestPropfind,
  MKCOL: handleRequestMkcol,
  HEAD: handleRequestHead,
  GET: handleRequestGet,
  POST: handleRequestPost,
  PUT: handleRequestPut,
  COPY: handleRequestCopy,
  MOVE: handleRequestMove,
  DELETE: handleRequestDelete,
};

export const onRequest: PagesFunction<{
  WEBDAV_USERNAME: string;
  WEBDAV_PASSWORD: string;
  WEBDAV_PUBLIC_READ?: string;
}> = async function (context) {
  try {
    const env = context.env;
    const request: Request = context.request;
    if (request.method === "OPTIONS") return handleRequestOptions();

    const skipAuth =
      env.WEBDAV_PUBLIC_READ === "1" &&
      ["GET", "HEAD", "PROPFIND"].includes(request.method);

    if (!skipAuth) {
      if (!env.WEBDAV_USERNAME || !env.WEBDAV_PASSWORD)
        return new Response("WebDAV protocol is not enabled", { status: 403 });

      const auth = request.headers.get("Authorization");
      if (!auth) return unauthorized();

      const expectedAuth = `Basic ${btoa(
        `${env.WEBDAV_USERNAME}:${env.WEBDAV_PASSWORD}`
      )}`;
      if (!timingSafeEqual(auth, expectedAuth)) return unauthorized();
    }

    const [bucket, path] = parseBucketPath(context);
    if (!bucket)
      return new Response(
        "R2 bucket binding is not configured: bind a bucket to the BUCKET variable",
        { status: 500 }
      );

    const method: string = (context.request as Request).method;
    
    // Special case: DELETE ?uploadId is handled by the post module
    if (method === "DELETE") {
      const url = new URL(context.request.url);
      const searchParams = new URLSearchParams(url.search);
      if (searchParams.has("uploadId")) {
        return handleRequestPostAbortMultipart({ bucket, path, request: context.request });
      }
    }
    
    const handler = HANDLERS[method] ?? handleMethodNotAllowed;
    return handler({ bucket, path, request: context.request });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(`Internal Server Error: ${message}`, { status: 500 });
  }
};
