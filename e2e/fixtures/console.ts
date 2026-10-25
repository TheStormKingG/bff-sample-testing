/**
 * Console and network observation.
 *
 * "No console error" is two different claims and they need separating. A
 * message the application emitted (`console.error`) or an exception nobody
 * caught is a defect in the application. A line the BROWSER writes because a
 * resource came back non-2xx is a report about the network — and in these
 * specs the network is partly our own mock, so grading the application on it
 * would grade our fixtures. So the two are collected separately and each spec
 * says which one it asserts on.
 */

import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

/** Chromium's own wording when a subresource request fails. */
const BROWSER_RESOURCE_NOTICE = /failed to load resource|net::ERR_|the server responded with a status of/i;

export interface PageObservations {
  /** console.error() and friends, emitted by page scripts. */
  readonly appErrors: string[];
  /** Browser-generated notices about non-2xx or failed subresources. */
  readonly resourceNotices: string[];
  /** Uncaught exceptions and unhandled rejections. */
  readonly pageErrors: string[];
  readonly requests: Request[];
  readonly responses: Response[];
  /** Responses with a 5xx status, which are never expected. */
  serverErrors(): string[];
}

/**
 * Attach listeners. Call BEFORE the first navigation, or the earliest messages
 * are missed and the spec silently observes less than it claims to.
 */
export function observePage(page: Page): PageObservations {
  const appErrors: string[] = [];
  const resourceNotices: string[] = [];
  const pageErrors: string[] = [];
  const requests: Request[] = [];
  const responses: Response[] = [];

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BROWSER_RESOURCE_NOTICE.test(text)) {
      resourceNotices.push(text);
      return;
    }
    const location = message.location();
    appErrors.push(`${text}  [${location.url}:${location.lineNumber}]`);
  });

  page.on('pageerror', (error: Error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
  });

  page.on('request', (request: Request) => {
    requests.push(request);
  });

  page.on('response', (response: Response) => {
    responses.push(response);
  });

  return {
    appErrors,
    resourceNotices,
    pageErrors,
    requests,
    responses,
    serverErrors() {
      return responses
        .filter((response) => response.status() >= 500)
        .map((response) => `${response.status()} ${response.url()}`);
    },
  };
}
