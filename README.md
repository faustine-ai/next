# @faustine-ai/next

The [Faustine](https://faustine.ai) Web Agent in a Next.js app: one client
component that mounts the agent, a helper that signs the user's identity on
the server, and the **adapter** that lets the agent call your Server Actions
and server-only data functions through a route handler you own.

```bash
npm install @faustine-ai/next @faustine-ai/web-agent
```

Most teams never write the code below by hand: the portal's *Install the
assistant* card gives a one-line command for your coding agent
(`npx skills add faustine-ai/skills`, then `/install-faustine …`).

## Mount the agent

```tsx
// app/faustine-agent.tsx
'use client';
import { FaustineAgent } from '@faustine-ai/next/client';

export default function Agent({ identityJwt }: { identityJwt?: string | null }) {
  return <FaustineAgent agentId="<YOUR_AGENT_ID>" identityJwt={identityJwt} />;
}
```

Render it once from `app/layout.tsx`, after `{children}`. The layout stays a
Server Component. `env` picks one of the Web Agent's environments when your
deployments map to several (default `Production`); `debug` opens a debug
session for the portal's Tests tab — development and staging only.

## Identity from the server

When the app has a session, sign a short-lived token so the agent knows who
the user is (the portal shows conversations as **Verified**):

```ts
import { faustineIdentityToken } from '@faustine-ai/next';

const identityJwt = user
  ? faustineIdentityToken({ id: user.id, name: user.name, email: user.email })
  : null;
```

`FAUSTINE_IDENTITY_SECRET` comes from the portal (*Settings → Identity
verification*) and is read on the server only. Without it the visitor is
anonymous.

## The adapter

Server Actions cannot be called from outside the app. The adapter is a
registry of the operations you choose to expose and a route handler that runs
them, in your app, with your auth and your validation:

```bash
npx faustine-next init --setup <code>   # the portal mints the code
```

`init` reads the operations Faustine found in your code, lets you pick which
to bind, and writes:

- `faustine/registry.ts` — one line per bound operation, importing your own
  functions. A removed line is a closed door.
- `app/api/faustine/[...op]/route.ts`:

  ```ts
  import { createFaustineHandler } from '@faustine-ai/next';
  import { registry } from '@/faustine/registry';
  export const { GET, POST } = createFaustineHandler(registry);
  ```

The handler only runs operations that are **both** in the registry and
enabled for the Web Agent's served version; it refuses everything else.
Add a Server Action later and run `npx faustine-next sync` (`--check` as a CI
gate); `npx faustine-next doctor` compares the running app with what Faustine
expects.

Optional: `withFaustine(nextConfig)` in `next.config.*` records the build's
commit, so the portal can tell which deployment is live.

## Requirements

Next.js 14+ (App Router or Pages Router), React 18+. The agent widget itself
is `@faustine-ai/web-agent`.

MIT.
