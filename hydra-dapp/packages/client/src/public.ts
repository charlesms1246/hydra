/**
 * Reading and writing the public class — the surface that existed everywhere except in a client.
 *
 * `decisions/0035` scoped the whole moderation pipeline to "public blobs only". The vault serves
 * `/v1/pub`, a removal authority guards takedowns of it, report intake refuses anything that is
 * not a `pub:` id, the transparency report filters on the same prefix, and `removedIds` publishes
 * the ids of removed public objects. **And no client could create one or read one.** `publish()`
 * in `vault-client` had no caller outside tests, and no client source touched `PUBLIC_ENDPOINT`.
 *
 * It went unnoticed partly because of a name: `hydra publish` means "sign this so anyone holding
 * your bundle can prove you wrote it" — a claim about ATTRIBUTION inside an encrypted channel —
 * and reads as though it were the public surface. It is not, and the commands here are `post` and
 * `fetch` rather than reusing the word.
 *
 * WHAT A PUBLIC READ DISCLOSES, AND WHY IT IS NOT THE ENCRYPTED STORY.
 *
 * `read.hit` says decoy padding in a read batch is free, because a miss is indistinguishable from
 * an object that expired or was never sent. That is true, and it does not rescue this. The
 * encrypted defence works because a channel's read set is DERIVED — the reader asks for its whole
 * channel at once, so `read.channelSet` discloses the grouping rather than which object was
 * wanted. A public read has no grouping to hide inside: each id is an independently wanted object,
 * so a batch of one real id and seven invented ones tells the operator which one was wanted by
 * which one hit.
 *
 * Padding is only possible against OTHER REAL PUBLIC IDS the reader already holds, and there is no
 * discovery surface to supply them. So this does not pad, and it does not pretend to: fetching a
 * public post tells the vault operator that somebody at your address wanted that specific object,
 * at that moment. `read.publicObject` carries the row, and `describeFetch` puts it in front of the
 * person about to do it — a reader of a controversial post is exactly who needs to know first.
 */

import { PUBLIC_ENDPOINT, openPublic, publish, wireBytes, uploadPathFor }
  from "../../vault-client/src/blobs.ts";
import type { PublicBlob, PublishIntent } from "../../vault-client/src/blobs.ts";

/**
 * Put a public object on a vault.
 *
 * NO JITTER AND NO COVER, deliberately, and it is a cost rather than an oversight. The timing
 * defence in `channel/src/schedule.ts` derives its decoys from a channel secret, and a public post
 * has no channel — there is nothing to derive cover from and nobody who would be sending it. So
 * the upload happens when the caller says, and the moment of upload is visible. `describePost`
 * says so before it happens.
 */
export async function postPublic(
  vaultUrl: string,
  plaintext: Uint8Array,
  intent: PublishIntent,
  invite: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicBlob> {
  const blob = publish(plaintext, intent);
  const res = await fetchImpl(`${vaultUrl}${uploadPathFor(blob)}`, {
    method: "PUT",
    headers: { "x-hydra-invite": invite },
    body: wireBytes(blob) as unknown as Uint8Array,
  });
  if (res.status !== 201) {
    throw new Error(`the vault refused the post (${res.status}): ${await res.text()}`);
  }
  return blob;
}

/**
 * Fetch public objects by id and return the ones that arrived intact.
 *
 * A BATCH BECAUSE THE ENDPOINT IS ONE, not because it hides anything — see the header. Asking for
 * several at once is still worth doing when a reader genuinely wants several, since it is one
 * request rather than several timed ones.
 *
 * A blob whose bytes do not hash to the id it was filed under is DROPPED AND REPORTED, never
 * returned. Returning it with a warning would put the decision in a caller who has already been
 * handed the bytes.
 */
export async function fetchPublic(
  vaultUrl: string,
  ids: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ found: Map<string, Uint8Array>; missing: string[]; substituted: string[] }> {
  const res = await fetchImpl(`${vaultUrl}${PUBLIC_ENDPOINT}`, {
    method: "POST",
    body: JSON.stringify(ids),
  });
  if (!res.ok) throw new Error(`the vault refused the read (${res.status})`);
  const body = await res.json() as { found?: Record<string, string> };
  const found = new Map<string, Uint8Array>();
  const substituted: string[] = [];
  for (const [id, b64] of Object.entries(body.found ?? {})) {
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    try {
      found.set(id, openPublic(id, bytes));
    } catch {
      substituted.push(id);
    }
  }
  return { found, missing: ids.filter((i) => !found.has(i) && !substituted.includes(i)), substituted };
}

/**
 * What posting costs, said before it happens.
 *
 * Rule 7: the cost stays on the page that performs the act. Everything here is permanent in a way
 * the encrypted class is not, and the second line is the one people get wrong — a public object is
 * public to EVERYONE, including the vault operator, forever, and unlike a message it was never
 * addressed to anybody who could be asked to delete it.
 */
export const describePost = (): string[] => [
  "THIS IS PUBLIC. Anyone who learns the id can read it, including the vault operator, and",
  "there is no key that changes that — it is stored in the clear because that is what public",
  "means here.",
  "",
  "It can be taken down and it cannot be unpublished. A removal stops this vault serving it;",
  "it does not reach anybody who already read it, and the on-chain record of your publishing",
  "still stands. See `decisions/0035`.",
  "",
  "It uploads NOW, with no jitter and no cover. The timing defence derives its decoys from a",
  "channel secret and a public post has no channel, so the moment you post is visible to the",
  "operator. Nothing here hides when.",
];

/** What fetching costs, said before it happens. */
export const describeFetch = (ids: readonly string[]): string[] => [
  `Asking this vault for ${ids.length === 1 ? "this object" : `these ${ids.length} objects`}`
  + " tells its operator that somebody at your address wanted",
  "exactly that, at this moment. A public read cannot be padded the way a channel read can:",
  "a channel asks for its whole derived set at once, so the grouping is what leaks rather than",
  "which object; a public id is wanted on its own, and an invented decoy id simply misses.",
  "",
  "If that matters for what you are about to read, fetch it from somewhere that is not the",
  "operator — the object is content-addressed, so a copy from anywhere verifies the same.",
];
