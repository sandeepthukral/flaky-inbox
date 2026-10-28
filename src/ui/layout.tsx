import type { Child } from 'hono/jsx';
import { clientScript } from './client';

export function Layout(props: {
  title: string;
  user: string;
  active: 'inbox' | 'stats' | 'message';
  children?: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} - flaky inbox</title>
        <style>{`
          body { font-family: system-ui, sans-serif; margin: 0; color: #222; }
          nav { display: flex; align-items: center; gap: 16px; padding: 10px 20px; background: #1f2937; color: #fff; }
          nav a { color: #cbd5e1; text-decoration: none; }
          nav a.active { color: #fff; font-weight: 600; }
          nav .brand { font-weight: 700; color: #fff; margin-right: 12px; }
          nav .user { margin-left: auto; font-size: 14px; color: #cbd5e1; }
          main { padding: 20px; }
        `}</style>
      </head>
      <body>
        <nav>
          <span class="brand">flaky inbox</span>
          <a href="/" class={props.active === 'inbox' ? 'active' : ''}>Inbox</a>
          <a href="/stats" class={props.active === 'stats' ? 'active' : ''}>Statistics</a>
          <span class="user">{props.user}</span>
        </nav>
        <main>{props.children}</main>
        <script dangerouslySetInnerHTML={{ __html: clientScript }} />
      </body>
    </html>
  );
}
