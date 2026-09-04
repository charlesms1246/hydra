#!/usr/bin/env node
/**
 * The moderator's tool.
 *
 * `decisions/0035` designed a moderation pipeline and an audit found that **zero of its eight
 * steps could be performed**: `moderation/src` had no callers outside its own tests. Every step
 * was a library call. This is the surface that was missing.
 *
 * A SEPARATE BINARY, and `decisions/0036` I8 is why. The two front ends this repo already has —
 * `cli` and `tui` — are user clients, and the cheap fix for eight missing steps is eight
 * subcommands on `hydra`. That is the one thing that must not happen: a client holds a user's
 * keys, this holds authority over other people's posts, and putting them in one binary means a
 * compromised messenger is a censorship tool.
 *
 *     node packages/operator/src/main.ts queue        --queue ./moderation.json
 *     node packages/operator/src/main.ts show    <id> --queue ./moderation.json
 *     node packages/operator/src/main.ts decide  <id> removed|kept <category>
 *     node packages/operator/src/main.ts remove  <id> --vault URL --removal-token-file FILE
 *     node packages/operator/src/main.ts report  <YYYY-MM>
 *     node packages/operator/src/main.ts intake  --port 8081 --spool ./reports.spool
 *     node packages/operator/src/main.ts ingest
 *
 * `decide` and `remove` are SEPARATE STEPS on purpose. A decision is a record; a removal is an act
 * against a vault that may be unreachable, may refuse, or may be one of several. Collapsing them
 * means a failed HTTP call either loses the decision or leaves a record of a removal that did not
 * happen — and a transparency report is generated from those records.
 */

import { readFileSync } from "node:fs";

import { removalAuthorityFromFile } from "../../vault-server/src/authority.ts";
import { load, save, ingest, clearSpool, summarise, transparencyReport, appealDigest,
  type Period } from "./queue.ts";
import { verifierAgainst } from "./verify.ts";
import { serveIntake } from "./intake.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) =>
  !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));

const [command, ...rest] = positional;
const queuePath = flag("queue", "./moderation-queue.json");
const spoolPath = flag("spool", "./reports.spool");
const now = () => Date.now();

/** The month a report covers, as a half-open range. `2026-09` means September, not 30 days. */
function monthOf(spec: string): Period {
  if (!/^\d{4}-\d{2}$/.test(spec)) throw new Error(`a period is YYYY-MM, not "${spec}"`);
  const [y, m] = spec.split("-").map(Number);
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) };
}

const out = (...lines: string[]) => console.log(lines.join("\n"));

switch (command) {
  case "queue": {
    const q = load(queuePath);
    const pending = q.pending();
    if (pending.length === 0) { out("Nothing waiting."); break; }
    // Oldest first: a review that has been open longest is the one most overdue, and sorting by
    // report volume would put the loudest first, which is the ranking an adversary chooses.
    for (const r of [...pending].sort((a, b) => a.openedAt - b.openedAt)) {
      out(`${r.blobId}  opened ${new Date(r.openedAt).toISOString().slice(0, 10)}  `
        + `${r.reports.length} report${r.reports.length === 1 ? "" : "s"}`
        + `${r.overflow ? ` (+${r.overflow} beyond what is kept)` : ""}`);
    }
    break;
  }

  case "show": {
    const q = load(queuePath);
    const review = q.pending().find((r) => r.blobId === rest[0]);
    if (!review) { out(`No open review for ${rest[0]}.`); process.exitCode = 1; break; }
    // `summarise` carries the count-is-not-a-person-count caveat in the same breath as the count.
    // Printed as it comes back rather than reformatted here, because the sentence is the point.
    out(...summarise(review, q.history(review.blobId)));
    break;
  }

  case "decide": {
    const [blobId, outcome, category] = rest;
    if (outcome !== "removed" && outcome !== "kept") {
      throw new Error(`an outcome is "removed" or "kept", not "${outcome}"`);
    }
    if (!category) throw new Error("a decision needs a category — it is what the report publishes");
    const q = load(queuePath);
    const d = q.decide(blobId, outcome, category, now());
    save(queuePath, q);
    // THE ID IS PRINTED BECAUSE AN APPEAL NAMES IT. Without it nobody can contest this decision —
    // the appellant signs a statement over this string, and it is opaque and random precisely so
    // that handing it over does not disclose how many decisions exist.
    out(`Recorded: ${blobId} ${outcome} (${category}).`,
      `Decision id: ${d.id}`,
      outcome === "removed"
        ? "The object is still on the vault. Run `remove` to take it down."
        : "Nothing to take down.");
    break;
  }

  case "remove": {
    const blobId = rest[0];
    const vault = flag("vault");
    const tokenFile = flag("removal-token-file");
    if (!vault) throw new Error("--vault is the vault to remove from");
    if (!tokenFile) throw new Error("--removal-token-file holds the operator's removal secret");
    // The only authority this tool holds, and it is a `RemovalAuthority` rather than a string —
    // see `decisions/0036`. There is no way to make one out of a value that is lying around.
    const authority = removalAuthorityFromFile(tokenFile);
    const res = await fetch(`${vault}/v1/pub/${blobId}`,
      { method: "DELETE", headers: { "x-hydra-removal": authority } });
    // The vault answers 404 both for "no such object" and for "your token is wrong", deliberately
    // — a distinguishable failure confirms an object exists to anyone probing ids. So this cannot
    // say which, and says so rather than guessing.
    out(res.ok
      ? `Removed ${blobId}.`
      : `The vault refused (${res.status}). It does not distinguish a wrong removal secret from `
        + "an object that is not there, so check both.");
    if (!res.ok) process.exitCode = 1;
    break;
  }

  case "intake": {
    // The public half, and the only part of this tool a stranger can reach. Run as its own
    // process: it accepts reports and appends them, and it never reads or writes the queue.
    const { url } = await serveIntake(spoolPath, Number(flag("port", "8081")),
      flag("rate-limit") ? { rateLimit: { mode: flag("rate-limit") as "global" | "per-peer",
        perMinute: Number(flag("per-minute", "600")) } } : {});
    out(`report intake on ${url}`,
      `spool     ${spoolPath}`,
      `limiter   ${flag("rate-limit") || "global at 600/min (the default)"}`,
      "reports   PUBLIC posts only; an encrypted object is refused with the reason, not dropped",
      "",
      "This process never touches the queue. Run `ingest` to fold what it collects into one.");
    break;
  }

  case "ingest": {
    const q = load(queuePath);
    const { filed, skipped } = ingest(spoolPath, q);
    // SAVE BEFORE CLEARING, always. The other order loses every report in the window between,
    // and the reports lost are ones a reporter was told had been filed.
    save(queuePath, q);
    clearSpool(spoolPath);
    out(`Filed ${filed} report${filed === 1 ? "" : "s"}.`
      + (skipped ? ` Skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"}.` : ""),
      `${q.pending().length} review${q.pending().length === 1 ? "" : "s"} now waiting.`);
    break;
  }

  case "appeals": {
    const q = load(queuePath);
    const waiting = q.appeals.outstanding();
    if (waiting.length === 0) { out("No appeals waiting."); break; }
    for (const a of waiting) {
      out(`${a.decisionId}  from ${a.account}  filed `
        + `${new Date(a.at).toISOString().slice(0, 10)}`);
    }
    break;
  }

  case "appeal": {
    // A DETACHED ARTIFACT, READ FROM A FILE. `decisions/0037`: an appeal must not have to arrive
    // over a connection the operator terminates, because that converts a chain identity into a
    // network observation at the worst moment. Taking it from a file is what makes "relay it by
    // any route you like" true rather than aspirational — including handing over a USB stick.
    const [decisionId, account] = rest;
    const artifact = flag("signature-file");
    const rpc = flag("rpc");
    if (!decisionId || !account) throw new Error("appeal <decisionId> <account> --signature-file F");
    if (!artifact) throw new Error("--signature-file holds the signature, one felt per line");
    if (!rpc) throw new Error("--rpc is a Starknet endpoint to verify the signature against");
    const signature = readFileSync(artifact, "utf8").split("\n").map((l) => l.trim())
      .filter(Boolean);
    const q = load(queuePath);
    if (!q.decisions().some((d) => d.id === decisionId)) {
      // Said before verifying, because it is not a signature problem and an appellant told "your
      // signature did not verify" would go looking for the wrong thing.
      out(`No decision ${decisionId} in this queue.`);
      process.exitCode = 1;
      break;
    }
    const result = await q.appeals.accept(decisionId, account, signature, now(),
      verifierAgainst(rpc));
    if (result.accepted) {
      save(queuePath, q);
      out(`Appeal recorded: ${account} against ${decisionId}.`);
    } else {
      // NOTHING IS SAVED ON A REFUSAL. An unverified submission is not evidence that anybody
      // appealed anything, and anyone can submit one naming any account.
      out(`Not recorded: ${result.reason}.`,
        "A network failure and a bad signature both refuse here; if the endpoint was unreachable",
        "this says nothing about the artifact.");
      process.exitCode = 1;
    }
    break;
  }

  case "appeal-resolve": {
    const [decisionId, account, outcome] = rest;
    if (outcome !== "upheld" && outcome !== "denied") {
      throw new Error(`an appeal outcome is "upheld" or "denied", not "${outcome}"`);
    }
    const q = load(queuePath);
    q.appeals.resolve(decisionId, account, outcome);
    save(queuePath, q);
    out(`Appeal ${outcome}: ${account} against ${decisionId}.`,
      outcome === "upheld"
        ? "The original decision is reversed. If it was a removal, the object is NOT restored by\n"
          + "this command — removal is not reversible, see decisions/0035."
        : "The original decision stands.");
    break;
  }

  case "digest": {
    // What an appellant signs, printed so they can be told it without a round trip. THIS IS THE
    // WHOLE POINT OF DROPPING THE NONCE: the digest is a pure function of the decision id, so an
    // appellant can compute it themselves and never contact the operator before appealing.
    if (!rest[0]) throw new Error("digest <decisionId>");
    out(appealDigest(rest[0]),
      "",
      "Sign this with the account that published the object. Anyone may deliver the result —",
      "the operator verifies the artifact, not the connection it arrived over.");
    break;
  }

  case "report": {
    const q = load(queuePath);
    const period = monthOf(rest[0] ?? "");
    // The second argument is the report volume, which `report` does not publish in any form —
    // see `transparency.ts`. Passed because the signature takes it; if it is ever published it
    // must be a decision made there, not a value that leaked through here.
    out(...transparencyReport(q.decisions(), q.receivedIn(period.from), period,
      q.appeals.filed()).lines);
    break;
  }

  default:
    out("hydra-operator — the moderator's tool. NOT a user client; see decisions/0036.",
      "",
      "  queue                          reviews waiting for a human",
      "  show <blobId>                  the reports against one object, with their limits",
      "  decide <blobId> removed|kept <category>",
      "  remove <blobId> --vault URL --removal-token-file FILE",
      "  report <YYYY-MM>               the transparency report for a month",
      "  intake --port N                the public report endpoint (its own process)",
      "  ingest                         fold filed reports into the queue",
      "  digest <decisionId>            what an appellant signs (they need not ask us)",
      "  appeals                        appeals waiting on a decision",
      "  appeal <decisionId> <account> --signature-file F --rpc URL",
      "  appeal-resolve <decisionId> <account> upheld|denied",
      "",
      `  --queue PATH                   where the queue lives (${queuePath})`,
      `  --spool PATH                   where intake appends reports (${spoolPath})`);
    if (command) process.exitCode = 1;
}
