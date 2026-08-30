/**
 * htm bound to React.createElement — JSX readability with no build step, which
 * keeps the repo's "clone and run" property. Everything else here is plain Ink.
 */
import React from "react";
import htm from "htm";

export const html = htm.bind(React.createElement);
export { React };
