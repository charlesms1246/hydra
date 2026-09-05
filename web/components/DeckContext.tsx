"use client";

import { createContext } from "react";

/**
 * Whether the subtree is inside a horizontal slide deck.
 *
 * ⛔ **This exists so `WriteOn` can refuse to run, and it is not a nicety.** `WriteOn`'s write
 * head is a function of `window.scrollY`. A deck is its own horizontal scroller, so the window's
 * scroll position does not move while a reader advances through slides — the head never advances,
 * every character stays at `opacity: 0`, and the slide serves invisible copy over artwork that is
 * still animating. **The failure is silent and total**, and it reads as a design choice rather
 * than as a bug, which is why it is worth a whole file to prevent.
 *
 * It ships with `WriteOn` rather than with the deck, before any deck exists, because the trap is
 * laid at the moment the effect is written and sprung much later by somebody else.
 *
 * The default is `false`: outside a deck the window is the scroller and the effect is correct.
 */
export const InDeck = createContext(false);
