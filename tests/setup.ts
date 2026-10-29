import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * `scrollIntoView`, which this environment does not have.
 *
 * MEASURED on the installed jsdom 25.0.1, not assumed:
 *
 *     typeof Element.prototype.scrollIntoView  ->  "undefined"
 *     vi.spyOn(Element.prototype, 'scrollIntoView')
 *         ->  throws "scrollIntoView does not exist"
 *
 * Those two facts decide how this is written. The method is ABSENT, not a
 * silent no-op, so any production code that calls it throws a TypeError here
 * — and because the property does not exist, a spy cannot attach to it and it
 * has to be DEFINED instead.
 *
 * Patching it here rather than guarding every call site keeps the application
 * honest: the components call the real DOM API, and the environment's gap is
 * closed where environments are configured.
 *
 * WHAT A TEST MAY AND MAY NOT CONCLUDE FROM THIS. The stub makes the CALL
 * observable, which is a fact about our code. It says nothing about the
 * RESULT, because jsdom has no layout engine: `window.scrollY` stays 0,
 * `getBoundingClientRect()` returns zeros, and `scroll-margin-top` does
 * nothing. So "did we ask to scroll, to what, with which alignment" is
 * testable here and "is the notice now visible" is not. The second question
 * needs a browser, and asserting it in jsdom would be measuring the absence
 * of a layout engine rather than this application.
 */
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});
