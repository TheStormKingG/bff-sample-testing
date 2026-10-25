import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';

/**
 * Render a legible failure into the page.
 *
 * Built with DOM nodes and `textContent` rather than `innerHTML`: the message
 * comes from a thrown error, and an error string is not markup. PRD
 * section 11 asks for understandable failures instead of an exception trace,
 * and a blank white page is the worst of both.
 */
function renderFatal(container: HTMLElement, detail: string): void {
  container.textContent = '';

  const wrap = document.createElement('div');
  wrap.setAttribute('role', 'alert');
  wrap.style.cssText =
    'max-width:40rem;margin:4rem auto;padding:1.5rem;border:2px solid #b91c1c;' +
    'border-radius:0.75rem;background:#fef2f2;font-family:system-ui,sans-serif;' +
    'color:#111827;line-height:1.5';

  const heading = document.createElement('h1');
  heading.style.cssText = 'margin:0 0 .5rem;font-size:1.25rem';
  heading.textContent = 'BFF Sample Testing could not start';

  const lead = document.createElement('p');
  lead.style.cssText = 'margin:0 0 1rem';
  lead.textContent =
    'This is a configuration or deployment problem, not something you did. ' +
    'Please show the message below to an administrator.';

  const pre = document.createElement('pre');
  pre.style.cssText =
    'margin:0;white-space:pre-wrap;word-break:break-word;font-size:.875rem;color:#7f1d1d';
  pre.textContent = detail;

  wrap.append(heading, lead, pre);
  container.append(wrap);
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) {
    // Nothing can be rendered anywhere, so the console is the only channel.
    console.error('BFF Sample Testing: #root is missing from index.html.');
    return;
  }

  try {
    /**
     * Imported dynamically, and before the app, on purpose.
     *
     * `@/lib/env` validates the four permitted `VITE_*` variables while its
     * module body runs, so a missing Supabase URL throws at import time. A
     * static import would throw before this function ever ran and the catch
     * below could not see it; an awaited dynamic import rejects instead, which
     * is catchable. The same is true of any other module-level failure in the
     * app, so this one catch covers startup as a whole.
     */
    await import('@/lib/env');
    const { App } = await import('@/App');

    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (cause) {
    renderFatal(
      container,
      cause instanceof Error ? cause.message : String(cause),
    );
    console.error('BFF Sample Testing failed to start', cause);
  }
}

void bootstrap();
