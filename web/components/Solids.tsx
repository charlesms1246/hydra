"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { AsciiEffect } from "three/examples/jsm/effects/AsciiEffect.js";

/**
 * The moving background: a field of solids, rendered as ASCII, driven by scroll.
 *
 * Ported from the reference's `AsciiCubes`, which is a hand-rolled rasteriser on a 2D canvas.
 * This one is real geometry through `three`, put through `AsciiEffect` so the output is still a
 * character grid — which matters, because a smooth shaded mesh would be the one object on this
 * site that looks like it came from somewhere else. Everything around it is a grid of glyphs.
 *
 * **Three things are taken from the reference deliberately.**
 *
 * 1. *Rotation is a pure function of scroll position*, not of scroll events firing an animation.
 *    Scrub backwards and the field runs backwards; leave the page alone and it holds still. The
 *    arrangement is a function of where the page is, so it cannot drift out of sync with it.
 * 2. *Each solid exits toward the corner FURTHEST from where it started.* Sending each one out
 *    by the shortest route is a dissolve — everything leaves at once by a different edge and the
 *    frame just thins. Aiming across the frame gives each the longest run, so the arrangement
 *    visibly travels rather than fading, and a solid that starts near an edge does not step off
 *    it in a few pixels of scroll.
 * 3. *The arrangement is generated per mount, never authored.* A hand-placed composition is the
 *    same on every visit, which turns a generative background into wallpaper — and a backdrop
 *    you recognise is a backdrop you start reading. Generating it inside the effect also keeps
 *    `Math.random()` out of the render pass, so there is no server/client hydration mismatch.
 *
 * **This is the only client component**, and it imports nothing but `three`. That is checked
 * rather than intended: `test/site.test.ts` walks the import graph of every `"use client"` file
 * and fails if one reaches `identity` or `vault-client`, which hold the derivation for the pool
 * viewing key and the vault content key. A decorative background is exactly the component that
 * grows an unreviewed import, because nobody reviews a background.
 *
 * **The page works without it.** Behind this is a `<pre>` holding the project's own ASCII hydra,
 * in the HTML with no script at all; this component hides it only once WebGL is actually
 * running. A reader on a filtered network, without WebGL, or asking for reduced motion keeps the
 * static drawing and every word of the page.
 *
 * Nothing is fetched. `three` is bundled from `node_modules` — no CDN, no texture, no request.
 *
 * ⛔ **THIS COMPONENT'S OPACITY CANNOT BE SET FROM CSS. Do not try.**
 *
 * The draw loop writes `mount.style.opacity` on every animation frame, and an inline style beats
 * any stylesheet rule — so a `@media` block targeting `.solids` **silently does nothing**. There
 * is no error, no warning, and no visible difference between "the rule is wrong" and "the rule is
 * being overwritten sixty times a second".
 *
 * That already happened once: the fix for the field drowning body text at 390px was written as a
 * media query, looked correct, and had no effect. It lives here now, in `rest`, alongside the
 * hero and reduced-motion decisions.
 *
 * **It is a guard-shaped failure in CSS** — the fix appears to be in the place a person would
 * naturally look for it, and is not. Every opacity decision for this element belongs in this
 * file; `globals.css` carries a pointer saying so.
 */

/** The ramp, darkest first. The reference's, minus the leading space so solids stay solid. */
const RAMP = " .:-=+*#%@";

/** Viewports of scroll over which the field clears the frame. */
const EXIT_VIEWPORTS = 1.15;

/** How far a solid travels at full exit, in the same world units as its position. */
const EXIT_DISTANCE = 13;

type Solid = {
  mesh: THREE.Mesh;
  home: THREE.Vector3;
  exit: THREE.Vector3;
  spin: THREE.Vector3;
  speed: number;
};

/**
 * Six kinds, not one.
 *
 * The reference uses cubes alone, which reads as a single object repeated. A mixed set of
 * platonic solids reads as a field of things, and at ASCII resolution the difference between a
 * dodecahedron and an icosahedron is exactly the kind of detail the character grid is good at
 * suggesting without ever quite resolving.
 */
function geometryFor(i: number): THREE.BufferGeometry {
  switch (i % 6) {
    case 0: return new THREE.BoxGeometry(1.5, 1.5, 1.5);
    case 1: return new THREE.TetrahedronGeometry(1.1);
    case 2: return new THREE.OctahedronGeometry(1.1);
    case 3: return new THREE.IcosahedronGeometry(1.05);
    case 4: return new THREE.DodecahedronGeometry(1.05);
    default: return new THREE.TorusGeometry(0.8, 0.34, 10, 18);
  }
}

/**
 * How many of the nine carry the accent.
 *
 * The brief was about ten percent of the render. Counting solids rather than pixels would put a
 * single one at eleven percent of the *field* but nothing like eleven percent of the *coverage*,
 * because scale varies by more than a factor of two — so the accented one is pinned to a
 * mid-range scale instead of a random one, which brings its share of the lit area to roughly a
 * tenth. The palette allows exactly one accent and spending it on more than this stops it being
 * an accent at all.
 */
const COUNT = 9;
const ACCENTED = 1;

/**
 * How strong the field is at the top of the page, before the exit fade takes it down.
 *
 * `AsciiEffect` returns near-white glyphs at full strength, which puts a second layer of type
 * behind the actual type at similar weight, and the eye cannot decide which to read. This is the
 * value at which the solids read as depth rather than as competition.
 */
const REST_OPACITY = 0.32;

export function Solids() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;

    // Motion is the whole point of this element, so when it is unwelcome the element does not
    // appear and the static drawing behind it stays. A "reduced" ambient animation is still an
    // ambient animation.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    /*
     * The landing page is built around this field; every other page is built around text.
     *
     * On `/` a full viewport of hero sits above the first sentence, so the solids have room to be
     * seen before anything has to be read. On `/install/` and the rest, prose starts immediately
     * and a field at landing-page strength competes with it from the first line — which is what
     * it did. So those pages get it dimmer and fade it out over half the distance: present at the
     * masthead, gone by the time anybody is reading.
     */
    const hero = !!document.querySelector(".hero");

    /*
     * Narrow viewports get it fainter still, and this has to be decided HERE rather than in CSS:
     * the draw loop writes `style.opacity` every frame, so an inline value beats any stylesheet
     * rule and a `@media` block for this silently does nothing. Found by rendering the site in
     * 390px iframes — the field is sized to span the viewport, so at that width its glyphs are
     * the same size as the body text and sit directly behind it.
     */
    const narrow = window.matchMedia("(max-width: 48rem)").matches;
    const rest = REST_OPACITY * (hero ? 1 : 0.45) * (narrow ? 0.4 : 1);
    const exitViewports = hero ? EXIT_VIEWPORTS : EXIT_VIEWPORTS * 0.45;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false });
    } catch {
      return; // No WebGL. Leave the ASCII drawing in place rather than showing nothing.
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.z = 7;

    // Lit, not flat: `AsciiEffect` picks a character by brightness, so a face that is not shaded
    // is a face with nothing to pick from. Ambient is high enough that the dark side of a solid
    // still lands on a glyph rather than dropping to the blank at the bottom of the ramp.
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-0.4, 0.6, 0.7);
    scene.add(key);

    const rand = (min: number, max: number) => min + Math.random() * (max - min);
    const accent = new Set<number>();
    while (accent.size < ACCENTED) accent.add(Math.floor(Math.random() * COUNT));

    const solids: Solid[] = [];
    for (let i = 0; i < COUNT; i++) {
      const isAccent = accent.has(i);
      const geometry = geometryFor(i);
      const material = new THREE.MeshPhongMaterial({
        color: isAccent ? 0xff4438 : 0xffffff,
        flatShading: true,
        shininess: 0,
      });
      const mesh = new THREE.Mesh(geometry, material);

      const home = new THREE.Vector3(rand(-3.6, 3.6), rand(-2.0, 2.0), rand(-1.6, 1.4));
      mesh.position.copy(home);
      // Pinned mid-range for the accented one — see ACCENTED above.
      const scale = isAccent ? 0.8 : rand(0.45, 1.1);
      mesh.scale.setScalar(scale);
      mesh.rotation.set(rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2));

      // The corner diagonally opposite. The two half-extents differ because the frame is not
      // square: at this depth the frustum is far wider than it is tall, so 8 and 3.5 are
      // comparable distances *on screen*. One figure for both would send everything out at 45°
      // regardless of the viewport's shape.
      const corner = new THREE.Vector3(home.x >= 0 ? -8 : 8, home.y >= 0 ? -3.5 : 3.5, 0);
      const exit = new THREE.Vector3(corner.x - home.x, corner.y - home.y, rand(-0.25, 0.25));
      exit.normalize();

      solids.push({
        mesh,
        home,
        exit,
        spin: new THREE.Vector3(rand(0.4, 1), rand(0.4, 1), rand(0.2, 0.6)),
        speed: rand(0.7, 1.5) * (Math.random() < 0.5 ? -1 : 1),
      });
      scene.add(mesh);
    }

    // `color` so the accented solid comes out accented; `invert` because the page is black and
    // the ramp is written for ink on paper.
    const effect = new AsciiEffect(renderer, RAMP, { resolution: 0.19, color: true, invert: true });
    effect.domElement.style.color = "#4a4a4a";
    effect.domElement.style.backgroundColor = "transparent";
    mount.appendChild(effect.domElement);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      effect.setSize(w, h);
    };
    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    const travel = new THREE.Vector3();

    const draw = () => {
      frame = requestAnimationFrame(draw);

      // Read live, never cached from a scroll handler. A cached value is wrong after a
      // back-navigation restores the scroll position without firing an event, and it only
      // repairs itself if the reader happens to scroll — which is the bug that makes a field
      // claiming to be a function of scroll position quietly not be one.
      const scrolled = window.scrollY / Math.max(window.innerHeight, 1);
      const progress = Math.min(1, scrolled / exitViewports);
      const eased = progress * progress;

      /*
       * The exit fade, and it is not a flourish — it is what makes the field readable.
       *
       * Each solid aims at the corner furthest from it, so the whole arrangement crosses the
       * MIDDLE of the frame on the way out. That is the effect, and it is also precisely where
       * the prose is. Geometry alone would park nine lit shapes behind section 01 at the moment
       * somebody is trying to read it. Fading against the same progress value means they are
       * already well dimmed by the time they cross, and gone before the section ends.
       */
      mount.style.opacity = String(rest * (1 - progress) ** 1.4);

      for (const s of solids) {
        travel.copy(s.exit).multiplyScalar(eased * EXIT_DISTANCE);
        s.mesh.position.copy(s.home).add(travel);

        const turn = scrolled * s.speed;
        s.mesh.rotation.x = s.spin.x * turn + s.mesh.userData.rx0;
        s.mesh.rotation.y = s.spin.y * turn + s.mesh.userData.ry0;
        s.mesh.rotation.z = s.spin.z * turn + s.mesh.userData.rz0;
      }

      renderer.render(scene, camera);
      effect.render(scene, camera);
    };

    // Keep each solid's starting orientation so scroll rotation is added to it rather than
    // replacing it — otherwise every solid snaps to the same angle the moment the page moves.
    for (const s of solids) {
      s.mesh.userData.rx0 = s.mesh.rotation.x;
      s.mesh.userData.ry0 = s.mesh.rotation.y;
      s.mesh.userData.rz0 = s.mesh.rotation.z;
    }

    // Only now is the no-script drawing redundant.
    document.body.classList.add("has-canvas");
    draw();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      for (const s of solids) {
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
      effect.domElement.remove();
      document.body.classList.remove("has-canvas");
    };
  }, []);

  return <div className="solids" ref={host} aria-hidden />;
}
