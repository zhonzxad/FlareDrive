import pLimit from "p-limit";

import { notFound } from "./utils";
import { listAll, RequestHandlerParams, WEBDAV_ENDPOINT } from "./utils";

const COPY_SUBREQUEST_LIMIT = 1000;
const COPY_CONCURRENCY = 5;

export async function handleRequestCopy({
  bucket,
  path,
  request,
}: RequestHandlerParams) {
  const dontOverwrite = request.headers.get("Overwrite") === "F";
  const destinationHeader = request.headers.get("Destination");
  if (destinationHeader === null)
    return new Response("Bad Request", { status: 400 });

  const src = await bucket.get(path);
  if (src === null) return notFound();

  let destPathname: string;
  try {
    destPathname = new URL(destinationHeader).pathname;
  } catch {
    try {
      destPathname = new URL(destinationHeader, request.url).pathname;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
  }
  const decodedPathname = decodeURIComponent(destPathname).replace(/\/$/, "");
  if (!decodedPathname.startsWith(WEBDAV_ENDPOINT))
    return new Response("Bad Request", { status: 400 });
  const destination = decodedPathname.slice(WEBDAV_ENDPOINT.length);

  if (
    destination === path ||
    (src.httpMetadata?.contentType === "application/x-directory" &&
      destination.startsWith(path + "/"))
  )
    return new Response("Bad Request", { status: 400 });

  // Check if the destination already exists
  const destinationExists = await bucket.head(destination);
  if (dontOverwrite && destinationExists)
    return new Response("Precondition Failed", { status: 412 });

  const isDirectory =
    src.httpMetadata?.contentType === "application/x-directory";
  
  if (isDirectory) {
    const depth = request.headers.get("Depth") ?? "infinity";
    switch (depth) {
      case "0":
        break;
      case "infinity": {
        // Delete existing destination directory if overwriting
        if (destinationExists) {
          await deleteChildren(bucket, destination);
        }

        // Copy root directory
        await bucket.put(destination, src.body, {
          httpMetadata: src.httpMetadata,
          customMetadata: src.customMetadata,
        });

        const prefix = path + "/";
        const writtenKeys: string[] = [];
        let subrequestCount = 1; // Count the root put
        
        const copy = async (object: R2Object) => {
          subrequestCount++;
          if (subrequestCount > COPY_SUBREQUEST_LIMIT) {
            throw new Error("Insufficient Storage: subrequest limit exceeded");
          }
          
          const target = `${destination}/${object.key.slice(prefix.length)}`;
          const srcObj = await bucket.get(object.key);
          if (srcObj === null) return;
          await bucket.put(target, srcObj.body, {
            httpMetadata: object.httpMetadata,
            customMetadata: object.customMetadata,
          });
          writtenKeys.push(target);
        };

        const limit = pLimit(COPY_CONCURRENCY);
        const promises: Promise<void>[] = [];
        
        try {
          for await (const object of listAll(bucket, prefix, true)) {
            promises.push(limit(() => copy(object)));
          }
          await Promise.all(promises);
        } catch (error) {
          // Rollback on failure: delete all written keys
          for (const key of writtenKeys) {
            try {
              await bucket.delete(key);
            } catch {
              // Ignore cleanup errors
            }
          }
          // Also delete the root directory if we wrote it
          try {
            await bucket.delete(destination);
          } catch {
            // Ignore cleanup errors
          }
          throw error;
        }
        
        break;
      }
      default:
        return new Response("Bad Request", { status: 400 });
    }
  } else {
    await bucket.put(destination, src.body, {
      httpMetadata: src.httpMetadata,
      customMetadata: src.customMetadata,
    });
  }

  if (destinationExists) {
    return new Response(null, { status: 204 });
  } else {
    return new Response("", { status: 201 });
  }
}

async function deleteChildren(bucket: R2Bucket, prefix: string) {
  const keysToDelete: string[] = [];
  for await (const obj of listAll(bucket, prefix + "/", true)) {
    keysToDelete.push(obj.key);
    if (keysToDelete.length >= 1000) {
      await bucket.delete(keysToDelete);
      keysToDelete.length = 0;
    }
  }
  if (keysToDelete.length > 0) {
    await bucket.delete(keysToDelete);
  }
}
