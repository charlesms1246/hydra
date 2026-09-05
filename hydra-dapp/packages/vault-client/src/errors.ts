/**
 * What to say when the vault ANSWERS, and the answer is not one the client can use.
 *
 * **A VAULT THAT REFUSES THE CONNECTION AND A VAULT THAT ANSWERS BADLY ARE DIFFERENT FAILURES, AND
 * ONLY THE FIRST WAS HANDLED.** `effects.ts:describeFailure` keys on `e.cause?.code` — `ECONNREFUSED`,
 * `ECONNRESET`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT` — which are all TRANSPORT failures. A vault
 * that accepts the connection and returns a 500, a 413, or an nginx error page has no `cause` at
 * all, so it passes straight through untouched. Driven, and this is what a user got:
 *
 *     the vault refused the inbox read: <html><head><title>502 Bad Gateway</title></head><body…
 *     the vault refused the inbox read:                       ← a 503 with an empty body
 *     Unexpected token '<', "<html>hello</html>" is not valid JSON
 *
 * The first pastes an entire HTML document into a log line one row tall. The second — the most
 * common real case, since most 5xx and most proxies send no body — says nothing whatsoever after
 * the colon. The third is a JavaScript parser error shown to a person.
 *
 * **THE STATUS CODE, WHICH IS THE ONLY ACTIONABLE PART, WAS IN NONE OF THEM.** A 413 is the
 * operator's size limit, a 401 is a spent or wrong invite, a 503 is somebody else's problem that
 * will pass, and to this client they were indistinguishable.
 *
 * MEANING FIRST, ADDRESS SECOND. These render in a TUI log line that truncates at the terminal
 * width, so the tail has to be the part you can afford to lose — the same ordering the identity
 * warning needed. The server's own prose is used ONLY where the status is one this does not
 * recognise, because for the ones it does, saying what the code means beats quoting a stack.
 */

/** One short line out of whatever a server sent: no markup, no newlines, bounded. */
function gist(body: string, cap = 60): string {
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/**
 * A sentence for a vault response the client cannot use.
 *
 * `doing` names the operation in the user's terms — "upload", "read" — because a status alone does
 * not say which half of a send failed.
 */
export function vaultSaid(vaultUrl: string, status: number, body: string, doing: string): string {
  if (status === 401 || status === 403) {
    return `the vault did not accept the invite for this ${doing} (${status} from ${vaultUrl})`;
  }
  if (status === 413) {
    // Not "the object is too large": on a READ the oversized thing is the list of ids, not a blob.
    return `${vaultUrl} refused this ${doing} as too large (413)`;
  }
  if (status === 429) {
    // Worth naming, because the obvious reaction is to send less and the cause is usually cover.
    return `${vaultUrl} is rate-limiting this ${doing} (429) — cover objects count against the `
      + "same budget as messages";
  }
  if (status >= 500) {
    return `the vault is failing rather than refusing (${status} from ${vaultUrl}) — nothing was `
      + `stored by this ${doing}`;
  }
  const said = gist(body);
  return `${vaultUrl} answered ${status} to this ${doing}${said ? ` — ${said}` : ""}`;
}

/**
 * Parse a vault response body, or say what arrived instead.
 *
 * **A 200 IS NOT A PROMISE OF JSON.** A proxy, a captive portal or a truncated body all produce a
 * successful status and a body `JSON.parse` rejects, and the raw parser error names neither the
 * vault nor the fact that one was involved.
 */
export async function vaultJson<T>(res: Response, vaultUrl: string, doing: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // THE DIAGNOSIS LEADS. The first version put "something is answering for the vault" at the
    // END, behind the URL, the status and a quoted body — so in a one-row log the reader got the
    // symptom and lost the conclusion. Same ordering rule as the identity warning: truncation eats
    // the tail, so the tail is the part you can afford to lose.
    const said = gist(text, 40);
    throw new Error(`something is answering for the vault — ${res.status} with a body that is not `
      + `JSON (${vaultUrl}${said ? `, starts "${said}"` : ", and empty"})`);
  }
}
