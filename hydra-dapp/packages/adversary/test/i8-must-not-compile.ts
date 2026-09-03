/**
 * I8's value-level half — every route that turns a user's value into removal authority.
 *
 * Not run. `i8-operator-separation.test.ts` type-checks this file and requires tsc to reject every
 * numbered attempt.
 *
 * `decisions/0036` argues that I8's MODULE-GRAPH half cannot have a fixture: this project includes
 * every package by construction, so an import written here fails for no reason tsc can express.
 * That argument stands and this file does not contradict it. What a fixture CAN carry is the
 * authority a tool HOLDS, and once `RemovalAuthority` is a type rather than a `string`, "a user
 * client ends up able to take a post down" becomes a compile error like any other.
 *
 * The class is the one E-DEL belonged to, on its fourth instance: an invite code, a user's delete
 * token and the operator's removal secret are three different authorities that were one type.
 */

import { serve } from "../../vault-server/src/http.ts";
import { removalAuthorityFromFile, authorises } from "../../vault-server/src/authority.ts";
import type { RemovalAuthority } from "../../vault-server/src/authority.ts";
import { Vault } from "../../vault-server/src/server.ts";
import { BUCKETS } from "../../vault-client/src/buckets.ts";
import { deleteToken } from "../../channel/src/deletion.ts";
import { channelSecret } from "../../channel/src/pointer.ts";
import { rootSeed, entropyFrom, derive, VAULT_DOMAIN, fromTestVector }
  from "../../identity/src/domains.ts";

const vault = new Vault({ invites: ["an-invite-code"], buckets: BUCKETS });
const seed = rootSeed(entropyFrom(fromTestVector(new Uint8Array(32).fill(2), "i8 fixture")));
const channel = channelSecret(derive(VAULT_DOMAIN, seed), "a channel");

// 1. The blunt one: a literal secret. Every removal authority comes from a file an operator holds,
//    so a value typed into source is not one.
await serve(vault, 0, { removalToken: "a-long-enough-operator-secret" });

// 2. An INVITE where a removal token is wanted. The two are both secrets the server was started
//    with, both strings, and they authorise completely different things — permission to upload
//    versus discretion over anyone's public post. This is the confusion the brand exists for.
const invite: string = "an-invite-code";
await serve(vault, 0, { removalToken: invite });

// 3. A USER'S DELETE TOKEN, which is the most dangerous version because it is the one that looks
//    plausible: it is a real secret, held by a real person, and it is a capability over ONE object
//    they created — not authority over anyone else's.
await serve(vault, 0, { removalToken: deleteToken(channel, "some-blob-id") });

// 4. Widen an authority back to a string and hand it in. A `RemovalAuthority` may be READ as a
//    string — it goes into a header — but the reverse is what must not typecheck.
const real: RemovalAuthority = removalAuthorityFromFile("/tmp/removal.token");
const widened: string = real;
await serve(vault, 0, { removalToken: widened });

// 5. Claim a value is one by declaring it. The brand is a unique symbol, so it cannot be named
//    from outside the module and this cannot be satisfied by writing the shape out.
const declared: RemovalAuthority = "a-long-enough-operator-secret";

// 6. Reach past the mint entirely by calling the comparison with a bare string as the authority.
//    `authorises` takes `unknown` on the OFFERED side deliberately — that is a header, and it is
//    the runtime half of the boundary — but the authority side is typed.
authorises("whatever a caller sent", "a-long-enough-operator-secret");

// NOT here, deliberately: `authorises(someString, real)`. That compiles, and should — comparing an
// untrusted header against a real authority is exactly what the server does on every DELETE.
