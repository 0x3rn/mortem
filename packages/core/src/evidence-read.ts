import {
  PlatformBindingError,
  type R2BucketLike,
  type R2ObjectBodyLike,
} from "./cloudflare";

/**
 * Reads a stored evidence object back from R2 as text, for checks that run on
 * captured evidence (SEO, accessibility). Returns `null` when the object is
 * missing; throws a typed `PlatformBindingError` when R2 cannot be read at all.
 */
export async function readEvidenceText(
  r2: R2BucketLike,
  key: string,
  purpose: string,
): Promise<string | null> {
  if (typeof r2.get !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "EVIDENCE",
      `The R2 binding 'EVIDENCE' cannot read objects, so ${purpose} cannot load captured evidence.`,
    );
  }
  let object: R2ObjectBodyLike | null;
  try {
    object = await r2.get(key);
  } catch (err) {
    throw new PlatformBindingError(
      "STORAGE_READ_FAILED",
      "EVIDENCE",
      `Failed to read ${key} from R2: ${err instanceof Error ? err.message : "unknown error"}`,
      { cause: err },
    );
  }
  if (!object) return null;
  return object.text
    ? object.text()
    : new TextDecoder().decode(await object.arrayBuffer());
}
