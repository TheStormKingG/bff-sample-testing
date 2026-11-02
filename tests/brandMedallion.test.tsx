/**
 * The spinning mark is built from the real logo, and it stops when asked.
 *
 * The supplied reference render could not be used directly: h264 carries no
 * alpha channel, so its "transparent" background is a light grey checkerboard
 * painted into every frame — sampled at roughly (246,249,247) and
 * (222,225,222), while the logo's own chicken is white. Keying the lighter
 * square would have punched holes through the bird. The motion is reproduced
 * instead, which is why these assertions are about structure rather than
 * about a video element.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { BrandMedallion } from '@/components/ui/BrandMedallion';
import { BRAND_LOGO_SRC } from '@/components/ui/BrandMark';

describe('the turning mark', () => {
  it('is the real logo, twice, not a video', () => {
    const { container } = render(<BrandMedallion />);
    const faces = container.querySelectorAll('img');
    // Two faces: one read from the front, one mirrored as it passes the back,
    // which is what the reference render shows.
    expect(faces).toHaveLength(2);
    for (const face of Array.from(faces)) {
      expect(face.getAttribute('src')).toBe(BRAND_LOGO_SRC);
    }
    expect(container.querySelector('video')).toBeNull();
  });

  it('carries no rim, so the badge is the logo and not a logo in a ring', () => {
    // The rim was a disc scaled 3% larger than the faces, sitting between
    // them to read as the coin's edge. Being LARGER than the logo it was
    // visible at every angle, including face-on, as a silver ring around the
    // mark. Removed at the owner's instruction; this is what stops it coming
    // back as a decorative flourish. Scene children are the two faces only.
    const { container } = render(<BrandMedallion />);
    const scene = container.querySelector('.animate-medallion-spin') as HTMLElement;
    const children = Array.from(scene.children);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.tagName).toBe('IMG');
    }
  });

  it('stops for anyone who has asked their device for less motion', () => {
    // A six-second loop in the eyeline for a whole shift is exactly the case
    // `prefers-reduced-motion` exists for. At rest this is simply the logo, so
    // nothing is lost by stopping.
    const { container } = render(<BrandMedallion />);
    const spinner = container.querySelector('.animate-medallion-spin');
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toContain('motion-reduce:animate-none');
  });

  it('keeps the drop shadow off the element that holds the 3D scene', () => {
    // A `filter` flattens `transform-style: preserve-3d`, which collapses the
    // layers into paint order — found when it rendered the coin as a plain
    // silver disc. The shadow belongs on the static wrapper.
    const { container } = render(<BrandMedallion />);
    const spinner = container.querySelector('.animate-medallion-spin') as HTMLElement;
    expect(spinner.style.filter).toBe('');
    const wrapper = spinner.parentElement as HTMLElement;
    expect(wrapper.style.filter).toContain('drop-shadow');
  });

  it('is decorative, because the name is rendered beside it as text', () => {
    const { container } = render(<BrandMedallion />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    for (const face of Array.from(container.querySelectorAll('img'))) {
      expect(face.getAttribute('alt')).toBe('');
    }
  });

  it('renders at the diameter it is given', () => {
    const { container } = render(<BrandMedallion size={128} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.width).toBe('128px');
    expect(wrapper.style.height).toBe('128px');
  });
});
