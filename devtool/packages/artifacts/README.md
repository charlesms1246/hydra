# `@hydra/artifacts`

The Cairo build outputs for **one** revision of
[`starknet-privacy`](https://github.com/starkware-libs/starknet-privacy), so `hydra-dev up` does
not have to compile them.

**84 files. 21 MB on disk. 3.9 MB over the wire.** npm serves it compressed and unpacks it plainly,
so the number that matters to your disk is the 21 MB, not the 3.9. It is a separate package for
that reason: `hydra-dev` itself is 234 kB and starts instantly, and installing this is a choice
you make to save ten to fifteen minutes of `scarb build`.

## What is in it

| kind | count | what it is |
| --- | --- | --- |
| `*.contract_class.json` | 58 | Sierra classes — what a `DECLARE` puts on chain |
| `*.compiled_contract_class.json` | 15 | CASM, the compiled form |
| `*.starknet_artifacts.json` | 11 | Scarb's own manifest of what each build wrote |

They come from five build invocations across five Scarb projects: the workspace (`privacy`,
`vesu_lending_anonymizer`, `ekubo_swap_anonymizer`, `shadow_account_anonymizer`), the same
workspace's `-t` test target, and the three standalone projects under `e2e/contracts/`.

They are stored under `artifacts/build/` and `artifacts/e2e/contracts/*/build/` rather than the
`target/dev/` Scarb writes them to: this repository's `.gitignore` excludes `target/` everywhere,
and git cannot re-include a file whose parent directory is excluded. `manifest.json` carries the
real destination for each file in `dest`, so nothing has to reconstruct that rule.

**Not included:** `artifacts/Primer.*`. Those are tracked in upstream's git rather than built, so
they arrive with the checkout — and the SDK pins that class hash, so a second copy would be a
second source for a value that must not drift.

## Checking it rather than trusting it

This ships build outputs, which is the opposite of how everything else here argues. So it is
checkable:

    npm test -w @hydra/artifacts        # recompute every hash and compare

`manifest.json` pins each file to `upstreamSha`, with a `kind` per entry because **the three kinds
take three different hashes** — `computeContractClassHash` for Sierra, `computeCompiledClassHash`
for CASM, and for an index neither, since it has no on-chain meaning and only its bytes can be
pinned. A single field called "class hash" would have read as a stronger claim than two thirds of
it are.

The check needs a `starknet` implementation, which this package deliberately does **not** depend
on — the upstream checkout already has one, and a second copy installed for every user of a
package whose job is to hold files is not worth it. It is found via `HYDRA_UPSTREAM`, or you can
`npm i starknet`.

**Building from source stays supported and is the fallback.** If this package is absent, at the
wrong revision, or fails its own check, `hydra-dev up` builds exactly as it did before.

## Licence and attribution

These are **upstream's build outputs**, produced from
`starkware-libs/starknet-privacy` at `980da8affafb9f8350975ca93c03b2299a31ac9b`, and are
redistributed under the **Apache License 2.0** — see `LICENSE`, copied verbatim from that commit.

Upstream ships no `NOTICE` file, so there is none to propagate: Apache 2.0 §4(d) requires carrying
a NOTICE only where the original work has one. Writing one here and attributing it to StarkWare
would be inventing an artifact, so this paragraph is the attribution instead.

No source file is redistributed. Nothing here is modified from what `scarb build` produced.
