import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/computer-code-engineering-services-section/semiotic-expression-notation/semantic-content-identity";

/**
 * Builds a semantic-identity function scoped to one domain record's
 * objectKind, over the shared identifyJsonSemanticContent primitive with a
 * fixed empty witness root -- none of this section's normalized brokerage
 * records carries evidential witnesses of its own. `objectKind` is the one
 * fact that distinguishes one record type's identity law from another's; the
 * mechanics around it (which primitive, which witness root) do not vary and
 * live here exactly once.
 * @param {string} objectKind The domain-specific object kind this identity is scoped to.
 * @returns {(value: unknown) => string} a pure function from a normalized record body to its semantic id.
 */
export function brokerageRecordSemanticId(objectKind) {
  if (typeof objectKind !== "string" || objectKind.trim() === "") throw new TypeError("object-kind-required");
  return (value) => identifyJsonSemanticContent({ objectKind, value, witnessRoot: EMPTY_WITNESS_ROOT }).id;
}
