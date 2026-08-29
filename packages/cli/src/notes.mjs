/**
 * Standing rule 6: privacy claims must be generated, never asserted. This note is
 * the one disclosure that is unconditionally true of every STRK20 deployment
 * (findings/01), so it is printed on every `up` rather than left to documentation.
 */

export const AUDITOR_NOTE = `
  Note: on a real pool, SetViewingKey encrypts the user's private viewing key to an
  auditor key held in contract storage. It is mandatory, cannot be opted out of or
  substituted, and is write-once. Your local pool is deployed with a key you control;
  mainnet and Sepolia are not. See findings/01-escrow.md.`;
