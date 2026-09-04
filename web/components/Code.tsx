import { Fragment } from "react";

/**
 * Renders `backticked` spans in hand-written copy as inline code.
 *
 * `content.ts` is prose written by a person, and a person writing about `npm install hydra` marks
 * it the way they would anywhere else. Without this the backticks reach the page as literal
 * characters — which looked like a typo on the install page, where the copy is dense with package
 * names and flags and half the sentence was punctuation.
 *
 * Deliberately only backticks. This is not a markdown renderer and should not become one: every
 * other construct would be a way to put markup in `content.ts`, which is meant to hold words.
 */
export function Code({ children }: { children: string }) {
  const parts = children.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}
