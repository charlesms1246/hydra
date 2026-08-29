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

function propValue(objLiteral, name) {
  const p = prop(objLiteral, name);
  if (!p) return undefined;
  return ts.isPropertyAssignment(p) ? p.initializer : undefined;
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
    if (ohttp === undefined) return report("HYD001", node, evidence);
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
      if (dp === undefined) {
        // No discoveryProvider key at all; not our call to judge.
      } else if (ts.isObjectLiteralExpression(dp)) {
        if (propValue(dp, "url")) {
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
          if (ohttp === undefined) report("HYD008", node, "options without ohttp");
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
          if (rl === undefined) {
            report("HYD004", node, "options present but no rateLimit");
          } else if (ts.isObjectLiteralExpression(rl)) {
            const c = numberOf(propValue(rl, "concurrency"));
            if (c === undefined)
              report("HYD005", node, "rateLimit without a literal concurrency (defaults to 8)");
            else if (c <= 8) report("HYD005", node, `concurrency: ${c}`);
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
