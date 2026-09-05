/**
 * AST analysis over SDK usage. Uses the TypeScript parser rather than regex so that
 * a commented-out or string-embedded config does not produce a false finding.
 *
 * No type checker: rules are shape-based and single-file, which keeps this fast and
 * dependency-light. The cost is that indirection (a provider built in another module)
 * is reported as HYD000 UNKNOWN rather than silently passing.
 */

import ts from "typescript";
import { RULES, POOLS } from "./rules.mjs";

const IGNORED_PARENTS = new Set([ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ExportDeclaration]);

function prop(objLiteral, name) {
  if (!objLiteral || !ts.isObjectLiteralExpression(objLiteral)) return undefined;
  return objLiteral.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name &&
      ts.isIdentifier(p.name) &&
      p.name.text === name
  );
}

/**
 * The value of a property, or a marker saying WHICH KIND of "no value" this is.
 *
 * Three states, not two, and collapsing two of them into `undefined` was one cause behind four
 * symptoms. `{ url }` is a `ShorthandPropertyAssignment`: the property is PRESENT and its value
 * is a reference this single-file, no-type-checker tool cannot follow. Read as "absent", that
 * made HYD001 miss the exact spelling its own `detail` quotes —
 * `createPrivateTransfers({ discoveryProvider: { url } })` — and exit 0, so a configuration that
 * posts the viewing key with no OHTTP walked through a gate built to stop it. The same read made
 * HYD004 announce "options present but no rateLimit" about `{ rateLimit }`, where the property is
 * sitting in the source it is describing.
 *
 * A spread does the same thing from the other side: `{ ...cfg }` may supply any name, so a name
 * not found in an object that spreads is UNRESOLVED rather than ABSENT.
 *
 * Standing rule 6 — a rule that cannot determine the answer reports UNKNOWN and never asserts —
 * only holds if "cannot determine" can reach the rules. That is what UNRESOLVED is for.
 */
const ABSENT = Symbol("property is not there");
const UNRESOLVED = Symbol("property is there and its value cannot be read statically");

function propValue(objLiteral, name) {
  const p = prop(objLiteral, name);
  if (!p) {
    if (!objLiteral || !ts.isObjectLiteralExpression(objLiteral)) return ABSENT;
    return objLiteral.properties.some((x) => ts.isSpreadAssignment(x)) ? UNRESOLVED : ABSENT;
  }
  // Shorthand, and anything else that is not a plain `name: value`.
  return ts.isPropertyAssignment(p) ? p.initializer : UNRESOLVED;
}

/** Reads a numeric literal, or undefined when it is not statically knowable. */
function numberOf(node) {
  if (node && ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function isTrue(node) {
  return node?.kind === ts.SyntaxKind.TrueKeyword;
}
function isFalse(node) {
  return node?.kind === ts.SyntaxKind.FalseKeyword;
}

/** Normalises a hex/decimal address literal to BigInt, or null. */
function addressOf(node) {
  if (!node) return null;
  const raw = ts.isStringLiteral(node)
    ? node.text
    : ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
      ? node.text.replace(/n$/, "")
      : null;
  if (raw === null) return null;
  if (!/^0x[0-9a-fA-F]+$|^\d+$/.test(raw.trim())) return null;
  try {
    return BigInt(raw.trim());
  } catch {
    return null;
  }
}

export function analyzeSource(fileName, sourceText) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const findings = [];
  const poolsSeen = new Set();
  let usesPool = false;

  const at = (node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, col: character + 1 };
  };
  const report = (rule, node, evidence) =>
    findings.push({ rule, ...RULES[rule], file: fileName, ...at(node), evidence });

  /** Inspects an options object for OHTTP on a key-bearing provider. */
  const checkOhttp = (optionsNode, node, evidence) => {
    const ohttp = propValue(optionsNode, "ohttp");
    if (ohttp === ABSENT) return report("HYD001", node, evidence);
    if (ohttp === UNRESOLVED) return report("HYD000", node, `${evidence} — ohttp is not a literal`);
    if (isFalse(ohttp)) return report("HYD002", node, evidence);
    if (isTrue(ohttp) || ts.isObjectLiteralExpression(ohttp)) return;
    report("HYD000", node, `${evidence} — ohttp is not a literal`);
  };

  const visit = (node) => {
    // Pool addresses anywhere in the file.
    const addr = addressOf(node);
    if (addr !== null && !IGNORED_PARENTS.has(node.parent?.kind)) {
      for (const [net, val] of Object.entries(POOLS)) {
        if (addr === val) {
          poolsSeen.add(net);
          usesPool = true;
        }
      }
    }

    // createPrivateTransfers({ ... })
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createPrivateTransfers"
    ) {
      usesPool = true;
      const arg = node.arguments[0];
      const dp = propValue(arg, "discoveryProvider");
      if (dp === ABSENT) {
        // No discoveryProvider key at all; not our call to judge.
      } else if (dp === UNRESOLVED) {
        report("HYD000", arg ?? node, "discoveryProvider is not an inline literal");
      } else if (ts.isObjectLiteralExpression(dp)) {
        // `!== ABSENT`, not truthiness: `{ url }` names a url this tool cannot read, and that
        // is still a url. It is the OHTTP question that decides the rule, not the spelling.
        if (propValue(dp, "url") !== ABSENT) {
          checkOhttp(dp, dp, "discoveryProvider: { url: … }");
        }
      } else if (!ts.isNewExpression(dp)) {
        report("HYD000", dp, "discoveryProvider is not an inline literal");
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const ctor = node.expression.text;

      if (ctor === "IndexerDiscoveryProvider") {
        usesPool = true;
        report("HYD003", node, "new IndexerDiscoveryProvider(…)");
        // HYD001 is reserved for the createPrivateTransfers config path, where the
        // developer cannot enable OHTTP at all. Explicit construction had the option
        // available, so under-reporting here is deliberate.
        const opts = node.arguments?.[2];
        if (opts === undefined) report("HYD008", node, "two-argument construction");
        else if (ts.isObjectLiteralExpression(opts)) {
          const ohttp = propValue(opts, "ohttp");
          if (ohttp === ABSENT) report("HYD008", node, "options without ohttp");
          else if (ohttp === UNRESOLVED) report("HYD000", node, "ohttp is not a literal");
          else if (isFalse(ohttp)) report("HYD002", node, "ohttp: false");
          else if (!isTrue(ohttp) && !ts.isObjectLiteralExpression(ohttp) && !ts.isConditionalExpression(ohttp))
            report("HYD000", node, "ohttp is not a literal");
        } else report("HYD000", node, "IndexerDiscoveryProvider options not a literal");
      }

      if (ctor === "ContractDiscoveryProvider") {
        usesPool = true;
        const opts = node.arguments?.[1];
        if (opts === undefined) {
          report("HYD004", node, "new ContractDiscoveryProvider(pool) with no options");
        } else if (ts.isObjectLiteralExpression(opts)) {
          const rl = propValue(opts, "rateLimit");
          if (rl === ABSENT) {
            report("HYD004", node, "options present but no rateLimit");
          } else if (rl === UNRESOLVED) {
            report("HYD000", node, "rateLimit is not a literal");
          } else if (ts.isObjectLiteralExpression(rl)) {
            const cv = propValue(rl, "concurrency");
            if (cv === ABSENT) {
              // `rateLimit: {}` really does default to 8. That is a fact about the config.
              report("HYD005", node, "rateLimit without a literal concurrency (defaults to 8)");
            } else if (cv === UNRESOLVED) {
              report("HYD000", node, "concurrency is not a literal");
            } else {
              const c = numberOf(cv);
              if (c === undefined) report("HYD000", node, "concurrency is not a numeric literal");
              else if (c <= 8) report("HYD005", node, `concurrency: ${c}`);
            }
          } else {
            report("HYD000", node, "rateLimit is not a literal");
          }
        } else {
          report("HYD000", node, "ContractDiscoveryProvider options not a literal");
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  if (poolsSeen.size > 1) {
    findings.push({
      rule: "HYD006",
      ...RULES.HYD006,
      file: fileName,
      line: 1,
      col: 1,
      evidence: `pool addresses for: ${[...poolsSeen].sort().join(" and ")}`,
    });
  }

  if (usesPool) {
    const net = poolsSeen.size === 1 ? [...poolsSeen][0] : null;
    findings.push({
      rule: "HYD007",
      ...RULES.HYD007,
      file: fileName,
      line: 1,
      col: 1,
      evidence: net ? `${net} pool` : "pool usage detected",
    });
  }

  return findings;
}
