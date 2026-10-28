import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

// Local stand-ins for the action/web imports (testConfig, step). Method bodies below are unchanged.
const testConfig = {
  mailinator: {
    apiBaseUrl: process.env.MAILINATOR_API_BASE_URL ?? 'http://127.0.0.1:8787/api/v2',
    domain: process.env.MAILINATOR_DOMAIN ?? 'staging.test.example',
  },
};
// No-op method decorator (works for both legacy and standard decorators).
function step(..._args: unknown[]): void {}

export type MailinatorMessageSummary = {
  id: string;
  subject: string;
  to: string;
  from: string;
  seconds_ago: number;
};

type InboxResponse = {
  msgs?: MailinatorMessageSummary[];
};

type LinksResponse = {
  links?: string[];
};

// Mail delivery is out of our hands, so this is the one place in the suite that polls
// on a timer instead of waiting on a web-first assertion.
const DEFAULT_TIMEOUT = 90_000;
const POLL_INTERVAL = 5_000;

/**
 * Reads throwaway inboxes on a Mailinator private domain (see testConfig.mailinator).
 *
 * Takes Playwright's `request` fixture rather than the page, so calls run in Node:
 * that bypasses both MSW's catch-all route handler and the Cloudflare access headers
 * applied to the browser context.
 */
export class MailinatorClient {
  private readonly request: APIRequestContext;
  private readonly domain: string;
  private readonly apiKey: string;

  constructor(request: APIRequestContext, domain: string = testConfig.mailinator.domain) {
    const apiKey = process.env.MAILINATOR_API_KEY;
    if (!apiKey) {
      throw new Error(
        'MAILINATOR_API_KEY has to be defined to read test inboxes. Add it to .env.local locally, or to the repository secrets in CI.'
      );
    }

    this.request = request;
    this.domain = domain;
    this.apiKey = apiKey;
  }

  private inboxUrl(inbox: string) {
    return `${testConfig.mailinator.apiBaseUrl}/domains/${this.domain}/inboxes/${inbox}`;
  }

  private get headers() {
    return { Authorization: this.apiKey };
  }

  private async get<Response>(url: string): Promise<Response> {
    const response = await this.request.get(url, { headers: this.headers });
    if (!response.ok()) {
      throw new Error(
        `Mailinator request failed: ${response.status()} ${response.statusText()} for ${url}`
      );
    }
    return (await response.json()) as Response;
  }

  /** Newest first, so the most recent mail wins when an inbox holds more than one. */
  @step
  async getMessages(inbox: string): Promise<MailinatorMessageSummary[]> {
    const body = await this.get<InboxResponse>(this.inboxUrl(inbox));
    return (body.msgs ?? []).sort((a, b) => a.seconds_ago - b.seconds_ago);
  }

  /**
   * Every link in the mail body. The message endpoint itself does not expose these on
   * a private domain, they only come back from this dedicated links endpoint.
   */
  @step
  async getLinks(inbox: string, messageId: string): Promise<string[]> {
    const body = await this.get<LinksResponse>(
      `${this.inboxUrl(inbox)}/messages/${messageId}/links`
    );
    return body.links ?? [];
  }

  private async findLinkStartingWith(inbox: string, prefix: string): Promise<string | undefined> {
    for (const message of await this.getMessages(inbox)) {
      const match = (await this.getLinks(inbox, message.id)).find((link) =>
        link.startsWith(prefix)
      );
      if (match) {
        return match;
      }
    }

    return undefined;
  }

  /**
   * Waits until any mail in the inbox carries a link starting with `prefix` (e.g. the
   * Gigya account-verification URL) and returns it. Every mail is checked on every
   * poll, so an unrelated mail arriving first does not fail the lookup.
   */
  @step
  async waitForLinkStartingWith(
    inbox: string,
    prefix: string,
    { timeout = DEFAULT_TIMEOUT }: { timeout?: number } = {}
  ): Promise<string> {
    let link: string | undefined;

    await expect
      .poll(
        async () => {
          link = await this.findLinkStartingWith(inbox, prefix);
          return link;
        },
        {
          message: `No mail in the "${inbox}" inbox on ${this.domain} carried a link starting with ${prefix}`,
          timeout,
          intervals: [POLL_INTERVAL],
        }
      )
      .toBeTruthy();

    // The poll above only resolves once a matching link exists.
    return link!;
  }
}
